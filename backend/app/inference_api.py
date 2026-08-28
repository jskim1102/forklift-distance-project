"""추론 제어 + 모델 가중치 관리 라우터 (/api/inference/*).

deepeye-lite ipcam.py 의 inference_router 차용. main.py 에서 include_router(inference_router).
"""

import tempfile
from pathlib import Path
from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from app.inference import models_dir
from app.streaming.manager import manager as stream_manager


# ─── 추론 제어 (모델 토글, ON/OFF, conf threshold) ───


class InferenceConfig(BaseModel):
    enabled: bool
    model: str
    conf_threshold: float
    device: str
    gpu_util_target: float
    gpu_util_duty: float


class InferenceConfigUpdate(BaseModel):
    enabled: bool | None = None
    model: str | None = None
    conf_threshold: float | None = None
    gpu_util_target: float | None = None


inference_router = APIRouter(prefix="/api/inference", tags=["inference"])


@inference_router.get("/config", response_model=InferenceConfig)
def get_inference_config() -> dict:
    """현재 추론 워커 상태."""
    return stream_manager.get_inference_config()


@inference_router.put("/config", response_model=InferenceConfig)
def update_inference_config(body: InferenceConfigUpdate) -> dict:
    """추론 ON/OFF · 모델 · conf threshold 변경. 부분 업데이트 지원."""
    if body.enabled is not None:
        stream_manager.set_inference_enabled(body.enabled)
    if body.model is not None:
        if body.model != models_dir.DEFAULT_MODEL:
            raise HTTPException(
                status_code=400,
                detail=f"기본 모델은 {models_dir.DEFAULT_MODEL}로 고정되어 있습니다",
            )
        stream_manager.set_inference_model(body.model)
    if body.conf_threshold is not None:
        stream_manager.set_inference_conf_threshold(body.conf_threshold)
    if body.gpu_util_target is not None:
        stream_manager.set_gpu_util_target(body.gpu_util_target)
    return stream_manager.get_inference_config()


# ─── 모델 목록 + 클래스 메타 ───


class ModelInfo(BaseModel):
    name: str
    type: str
    size_mb: float | None = None


@inference_router.get("/models", response_model=list[ModelInfo])
def list_models() -> list[dict]:
    """preset(YOLO26 5종)과 활성 custom이 있으면 그 하나를 반환한다."""
    return models_dir.list_all_models()


@inference_router.get("/models/{name}/classes")
def get_model_classes(name: str) -> list[dict]:
    """주어진 preset 모델의 클래스 ID→이름 목록.

    허용된 YOLO26 detection preset은 모두 COCO 80-class 모델이다. 클래스 이름 조회는
    정적 메타데이터만 반환하고 가중치 다운로드·모델 로드를 시작하지 않는다.
    """
    if not models_dir.is_preset(name):
        raise HTTPException(status_code=404, detail="알 수 없는 모델 (preset 만 가능)")

    return models_dir.list_model_classes(name)


class CustomWeightsStatus(BaseModel):
    name: str
    uploaded_at: str
    size_mb: float
    class_count: int


class WeightsStatus(BaseModel):
    preset_name: str
    custom: CustomWeightsStatus | None


def _refresh_source_models(*, reload_custom: str | None = None) -> None:
    """전역 기본 모델은 유지하고 모든 source의 lane 조합만 다시 계산한다."""
    if reload_custom is not None:
        stream_manager.reload_source_model(reload_custom)
    stream_manager.set_all_source_models(models_dir.get_active_model_names())


@inference_router.get("/weights", response_model=WeightsStatus)
def get_active_weights() -> dict:
    return models_dir.get_active_weights_status()


@inference_router.get("/classes")
def get_active_classes() -> list[dict]:
    """custom 가중치의 클래스 목록. custom이 없으면 선택 자체가 불가능하다."""
    try:
        return models_dir.list_active_classes()
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@inference_router.post("/weights", response_model=WeightsStatus)
async def upload_custom_weights(file: UploadFile = File(...)) -> dict:
    """최대 600MB `.pt`를 검증해 고정 preset의 두 번째 lane으로 교체한다."""
    original_name = Path(file.filename or "").name
    if not original_name or Path(original_name).suffix.lower() != ".pt":
        raise HTTPException(status_code=400, detail=".pt 파일만 업로드할 수 있습니다")
    if original_name == models_dir.DEFAULT_MODEL:
        raise HTTPException(
            status_code=400,
            detail=f"custom 파일명은 고정 person 모델 {models_dir.DEFAULT_MODEL}와 달라야 합니다",
        )

    directory = models_dir.custom_weights_path().parent
    directory.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    size_bytes = 0
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=".upload-",
            suffix=".pt",
            dir=directory,
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            while chunk := await file.read(1024 * 1024):
                size_bytes += len(chunk)
                if size_bytes > models_dir.MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=400,
                        detail="가중치 파일은 600MB를 초과할 수 없습니다",
                    )
                temporary.write(chunk)
        if size_bytes == 0:
            raise HTTPException(status_code=400, detail="빈 가중치 파일은 업로드할 수 없습니다")

        classes = models_dir.extract_model_classes(temporary_path)
        models_dir.activate_custom_weights(
            temporary_path,
            original_name=original_name,
            size_bytes=size_bytes,
            classes=classes,
        )
        temporary_path = None  # os.replace로 custom.pt가 됨
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        await file.close()
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    active_name = str(models_dir.get_custom_metadata()["original_name"])
    _refresh_source_models(reload_custom=active_name)
    return models_dir.get_active_weights_status()


@inference_router.delete("/weights", response_model=WeightsStatus)
def reset_custom_weights() -> dict:
    """custom lane만 제거하고 고정 yolo26x.pt는 계속 유지한다."""
    models_dir.delete_custom_weights()
    _refresh_source_models()
    return models_dir.get_active_weights_status()
