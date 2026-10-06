"""추론 제어 + 레인별 가중치 관리 라우터 (/api/inference/*).

가중치는 anchor·target 두 레인 슬롯으로만 다룬다. 레인 id 가 곧 worker 모델
식별자라서 파일이 바뀌어도 lane 이름은 그대로고, 교체는 lane reload 로 끝난다.
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
    """추론 ON/OFF · conf threshold · GPU 목표 변경. 부분 업데이트 지원."""
    if "model" in body.model_fields_set:
        raise HTTPException(
            status_code=400,
            detail="이 API에서는 모델을 변경할 수 없습니다. 레인별 가중치 API를 사용하세요.",
        )
    if body.enabled is not None:
        stream_manager.set_inference_enabled(body.enabled)
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
    """preset 카탈로그(YOLO26 5종). 레인 개념과 독립이다."""
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


# ─── 레인 가중치 ───


class LaneStatus(BaseModel):
    lane: str
    source: str
    name: str
    uploaded_at: str | None
    size_mb: float | None
    class_count: int


class LanesStatus(BaseModel):
    lanes: dict[str, LaneStatus | None]


def _lanes_payload() -> dict:
    return {"lanes": models_dir.get_all_lane_status()}


def _require_lane(lane: str) -> str:
    if not models_dir.is_lane(lane):
        raise HTTPException(status_code=404, detail="알 수 없는 레인")
    return lane


def _refresh_source_models(*, reload_lane: str | None = None) -> None:
    """레인 파일이 바뀐 뒤 worker lane 을 재생성하고 source 조합을 다시 계산한다."""
    if reload_lane is not None:
        stream_manager.reload_source_model(reload_lane)
    stream_manager.set_all_source_models(models_dir.get_active_lanes())


@inference_router.get("/weights", response_model=LanesStatus)
def get_lane_weights() -> dict:
    """두 레인 상태를 한 번에 반환한다. 비활성 레인은 null."""
    return _lanes_payload()


@inference_router.get("/lanes/{lane}/classes")
def get_lane_classes(lane: str) -> list[dict]:
    """레인의 클래스 목록. preset 이면 정적 COCO 80종, 업로드면 메타데이터."""
    _require_lane(lane)
    try:
        return models_dir.list_lane_classes(lane)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@inference_router.post("/lanes/{lane}/weights", response_model=LanesStatus)
async def upload_lane_weights(lane: str, file: UploadFile = File(...)) -> dict:
    """최대 600MB `.pt`를 검증해 해당 레인 슬롯으로 교체한다."""
    _require_lane(lane)
    original_name = Path(file.filename or "").name
    if not original_name or Path(original_name).suffix.lower() != ".pt":
        await file.close()
        raise HTTPException(status_code=400, detail=".pt 파일만 업로드할 수 있습니다")

    directory = models_dir.lane_weights_path(lane).parent
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
        models_dir.activate_lane_weights(
            temporary_path,
            lane=lane,
            original_name=original_name,
            size_bytes=size_bytes,
            classes=classes,
        )
        temporary_path = None  # os.replace로 <lane>.pt가 됨
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        await file.close()
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    _refresh_source_models(reload_lane=lane)
    return _lanes_payload()


@inference_router.delete("/lanes/{lane}/weights", response_model=LanesStatus)
def reset_lane_weights(lane: str) -> dict:
    """업로드 슬롯을 비운다. anchor 는 preset 으로 복귀하고 target 은 비활성이 된다."""
    _require_lane(lane)
    models_dir.delete_lane_weights(lane)
    # lane 이름이 유지된 채 내용만 preset 으로 바뀌는 레인은 reload 가 필요하다.
    still_active = lane in models_dir.get_active_lanes()
    _refresh_source_models(reload_lane=lane if still_active else None)
    return _lanes_payload()
