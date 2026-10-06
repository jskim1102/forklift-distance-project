"""레인 슬롯 기반 YOLO 가중치 관리.

레인은 ``anchor``(거리쌍 기준)와 ``target``(거리쌍 상대) 둘로 고정이다. 각 레인은
``WEIGHTS_DIR/<lane>.pt`` + ``WEIGHTS_DIR/<lane>.json`` 슬롯 한 쌍을 갖고, 슬롯이
비어 있으면 ``LANE_PRESET`` 의 preset 으로 떨어진다 — "preset 을 가리키는 상태"를
따로 저장하지 않으므로 메타데이터와 실물이 어긋날 수 없다.

worker 의 모델 식별자도 레인 id 다. 원본 파일명은 메타데이터의 ``original_name`` 에만
남아 표시용으로 쓰이므로, 두 레인에 같은 이름(심지어 preset 과 같은 이름)을 올려도
충돌하지 않는다.

API 프로세스는 ultralytics 를 import 하지 않으며 클래스 추출은 짧은 subprocess 에서 한다.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import config

logger = logging.getLogger(__name__)

# 레인 둘로 고정. 개수를 늘릴 계획이 없어 슬롯 파일 두 쌍이면 충분하다.
LANES: tuple[str, ...] = ("anchor", "target")
DEFAULT_LANE = "anchor"
# 업로드가 없으면 두 레인 모두 COCO preset 으로 동작한다.
LANE_PRESET: dict[str, str | None] = {"anchor": "yolo26x.pt", "target": "yolo26x.pt"}

DEFAULT_MODEL = "yolo26x.pt"  # preset 카탈로그 기본값
LEGACY_CUSTOM_WEIGHTS_FILENAME = "custom.pt"
LEGACY_CUSTOM_METADATA_FILENAME = "custom.json"
MAX_UPLOAD_BYTES = 600 * 1024 * 1024
CLASS_EXTRACTION_TIMEOUT_SEC = 60

# Preset 모델 — 카탈로그 + worker 자동 다운로드 기본값. 신뢰경계: ultralytics 공식 가중치만.
PRESET_MODELS: tuple[str, ...] = (
    "yolo26n.pt",
    "yolo26s.pt",
    "yolo26m.pt",
    "yolo26l.pt",
    "yolo26x.pt",
)

# 허용된 YOLO26 detection preset은 모두 COCO 80-class 모델이다. 클래스 설정 UI가
# 이름만 표시하려고 가중치 전체를 다운로드하지 않도록 메타데이터를 별도로 보관한다.
COCO_CLASS_NAMES: tuple[str, ...] = (
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
)


def _weights_dir() -> Path:
    return config.WEIGHTS_DIR


def is_lane(name: str) -> bool:
    """name 이 레인 id 인지 확인한다."""
    return name in LANES


def lane_weights_path(lane: str) -> Path:
    return _weights_dir() / f"{lane}.pt"


def lane_metadata_path(lane: str) -> Path:
    return _weights_dir() / f"{lane}.json"


def _legacy_custom_weights_path() -> Path:
    return _weights_dir() / LEGACY_CUSTOM_WEIGHTS_FILENAME


def _legacy_custom_metadata_path() -> Path:
    return _weights_dir() / LEGACY_CUSTOM_METADATA_FILENAME


def _migrate_legacy_target_slot() -> None:
    """구 ``custom.pt``/``custom.json`` 을 target 슬롯으로 lazy rename 한다.

    startup 훅이 아니라 조회 함수에서 부른다 — streaming.manager 싱글턴이 모듈 import
    시점에 활성 레인을 읽으므로 startup 훅은 그보다 늦다. target 슬롯이 이미 차 있으면
    레거시 파일을 건드리지 않는다(멱등). 실패하면 target preset 으로 진행하고, 사용자는
    재업로드로 업로드 모델을 회복한다.
    """
    target_weights = lane_weights_path("target")
    legacy_weights = _legacy_custom_weights_path()
    if (
        target_weights.exists()
        or lane_metadata_path("target").exists()
        or not legacy_weights.is_file()
    ):
        return
    legacy_metadata = _legacy_custom_metadata_path()
    try:
        # .json 을 먼저 옮긴다 — 중간에 죽어도 .pt 없는 반쪽 상태는 preset 으로 처리된다.
        if legacy_metadata.is_file():
            os.replace(legacy_metadata, lane_metadata_path("target"))
        os.replace(legacy_weights, target_weights)
    except OSError:
        logger.warning(
            "레거시 custom 가중치를 target 레인으로 이관하지 못했습니다", exc_info=True
        )


def _normalize_classes(value: Any) -> list[dict] | None:
    if not isinstance(value, list) or not value:
        return None
    classes: list[dict] = []
    for item in value:
        if not isinstance(item, dict):
            return None
        class_id = item.get("id")
        name = item.get("name")
        if not isinstance(class_id, int) or class_id < 0 or not isinstance(name, str) or not name:
            return None
        classes.append({"id": class_id, "name": name})
    return classes


def get_lane_metadata(lane: str) -> dict | None:
    """업로드 슬롯 메타데이터. 두 영속 파일이 모두 유효할 때만 활성으로 본다."""
    if not is_lane(lane):
        return None
    if lane == "target":
        _migrate_legacy_target_slot()
    weights_path = lane_weights_path(lane)
    metadata_path = lane_metadata_path(lane)
    if not weights_path.is_file() or not metadata_path.is_file():
        return None
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(metadata, dict):
        return None
    original_name = metadata.get("original_name")
    uploaded_at = metadata.get("uploaded_at")
    size_bytes = metadata.get("size_bytes")
    classes = _normalize_classes(metadata.get("classes"))
    if (
        not isinstance(original_name, str)
        or Path(original_name).name != original_name
        or Path(original_name).suffix.lower() != ".pt"
        or not isinstance(uploaded_at, str)
        or not isinstance(size_bytes, int)
        or size_bytes < 0
        or classes is None
    ):
        return None
    return {
        "original_name": original_name,
        "uploaded_at": uploaded_at,
        "size_bytes": size_bytes,
        "classes": classes,
    }


def get_lane_status(lane: str) -> dict | None:
    """레인 상태 1건. 업로드도 preset 도 없으면 None(비활성)."""
    if not is_lane(lane):
        return None
    metadata = get_lane_metadata(lane)
    if metadata is not None:
        return {
            "lane": lane,
            "source": "upload",
            "name": metadata["original_name"],
            "uploaded_at": metadata["uploaded_at"],
            "size_mb": metadata["size_bytes"] / 1024 / 1024,
            "class_count": len(metadata["classes"]),
        }
    preset = LANE_PRESET.get(lane)
    if preset is None:
        return None
    return {
        "lane": lane,
        "source": "preset",
        "name": preset,
        "uploaded_at": None,
        "size_mb": None,
        "class_count": len(COCO_CLASS_NAMES),
    }


def get_all_lane_status() -> dict[str, dict | None]:
    return {lane: get_lane_status(lane) for lane in LANES}


def get_active_lanes() -> list[str]:
    """worker·source 요청에 쓸 활성 레인 id 목록."""
    return [lane for lane in LANES if get_lane_status(lane) is not None]


def list_lane_classes(lane: str) -> list[dict]:
    """레인의 클래스 목록. preset 이면 정적 COCO 80종, 업로드면 메타데이터."""
    if not is_lane(lane):
        raise ValueError(f"알 수 없는 레인: {lane!r}")
    metadata = get_lane_metadata(lane)
    if metadata is not None:
        return list(metadata["classes"])
    preset = LANE_PRESET.get(lane)
    if preset is None:
        raise ValueError(f"{lane} 레인 가중치가 없습니다")
    return list_model_classes(preset)


def is_preset(name: str) -> bool:
    """name 이 허용된 공식 preset 인지 확인한다."""
    return name in PRESET_MODELS


def is_allowed_model(name: str) -> bool:
    """worker 입력으로 허용되는 것은 현재 활성 레인 id 뿐이다."""
    return name in get_active_lanes()


def list_all_models() -> list[dict]:
    """공식 preset 카탈로그. 레인 개념과 독립이다."""
    return [{"name": n, "type": "preset", "size_mb": None} for n in PRESET_MODELS]


def list_model_classes(name: str) -> list[dict]:
    """preset 모델의 COCO 클래스 메타데이터를 가중치 로드 없이 반환한다."""
    if not is_preset(name):
        raise ValueError(f"허용되지 않은 모델: {name!r} (preset 만 가능)")
    return [
        {"id": class_id, "name": class_name}
        for class_id, class_name in enumerate(COCO_CLASS_NAMES)
    ]


def extract_model_classes(path: Path) -> list[dict]:
    """업로드 모델 names를 격리 subprocess에서 읽는다."""
    script = """
import json
import sys
from ultralytics import YOLO

names = YOLO(sys.argv[1]).names
items = names.items() if isinstance(names, dict) else enumerate(names)
print(json.dumps([{"id": int(class_id), "name": str(name)} for class_id, name in items]))
""".strip()
    try:
        completed = subprocess.run(
            [sys.executable, "-c", script, str(path)],
            capture_output=True,
            text=True,
            timeout=CLASS_EXTRACTION_TIMEOUT_SEC,
            check=True,
        )
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        classes = _normalize_classes(json.loads(lines[-1])) if lines else None
    except (
        OSError,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        json.JSONDecodeError,
        IndexError,
    ) as exc:
        raise ValueError("가중치에서 클래스 정보를 추출하지 못했습니다") from exc
    if classes is None:
        raise ValueError("가중치의 클래스 정보가 비어 있거나 올바르지 않습니다")
    return classes


def activate_lane_weights(
    temporary_path: Path,
    *,
    lane: str,
    original_name: str,
    size_bytes: int,
    classes: list[dict],
) -> dict:
    """검증된 임시파일을 레인 슬롯으로 원자 교체하고 메타데이터를 기록한다."""
    if not is_lane(lane):
        raise ValueError(f"알 수 없는 레인: {lane!r}")
    directory = _weights_dir()
    directory.mkdir(parents=True, exist_ok=True)
    uploaded_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    metadata = {
        "original_name": Path(original_name).name,
        "uploaded_at": uploaded_at,
        "size_bytes": int(size_bytes),
        "classes": classes,
    }
    metadata_tmp = directory / f".{lane}.json.tmp"
    metadata_tmp.write_text(
        json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary_path, lane_weights_path(lane))
    os.replace(metadata_tmp, lane_metadata_path(lane))
    return metadata


def delete_lane_weights(lane: str) -> None:
    """업로드 슬롯을 비운다. preset 이 있는 레인은 preset 으로 복귀한다."""
    if not is_lane(lane):
        raise ValueError(f"알 수 없는 레인: {lane!r}")
    lane_weights_path(lane).unlink(missing_ok=True)
    lane_metadata_path(lane).unlink(missing_ok=True)


def resolve_model_path(name: str) -> str:
    """worker 모델 이름(레인 id)을 슬롯 파일 경로 또는 preset 이름으로 해석한다."""
    if is_lane(name):
        if get_lane_metadata(name) is not None:
            return str(lane_weights_path(name))
        preset = LANE_PRESET.get(name)
        if preset is not None:
            return preset
    raise ValueError(f"허용되지 않은 모델: {name!r}")
