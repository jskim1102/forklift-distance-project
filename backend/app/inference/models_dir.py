"""고정 YOLO preset + 보조 custom 가중치 관리.

기본 ``yolo26x.pt``는 항상 활성이고, 사용자가 올린 `.pt` 하나를 두 번째 lane으로
허용한다. 임의 경로는 계속 차단하고, custom 원본 이름은 고정된
``WEIGHTS_DIR/custom.pt`` 로만 해석한다.
API 프로세스는 ultralytics를 import하지 않으며 클래스 추출은 짧은 subprocess에서 한다.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import config

DEFAULT_MODEL = "yolo26x.pt"
CUSTOM_FILENAME = "custom.pt"
CUSTOM_METADATA_FILENAME = "custom.json"
MAX_UPLOAD_BYTES = 600 * 1024 * 1024
CLASS_EXTRACTION_TIMEOUT_SEC = 60

# Preset 모델 — UI 토글 + worker 자동 다운로드 기본값. 신뢰경계: ultralytics 공식 가중치만.
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


def custom_weights_path() -> Path:
    return _weights_dir() / CUSTOM_FILENAME


def custom_metadata_path() -> Path:
    return _weights_dir() / CUSTOM_METADATA_FILENAME


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


def get_custom_metadata() -> dict | None:
    """두 영속 파일이 모두 유효할 때만 custom을 활성 상태로 본다."""
    weights_path = custom_weights_path()
    metadata_path = custom_metadata_path()
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
        or original_name == DEFAULT_MODEL
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


def is_preset(name: str) -> bool:
    """name 이 허용된 공식 preset 인지 확인한다."""
    return name in PRESET_MODELS


def is_allowed_model(name: str) -> bool:
    """공식 preset 또는 현재 활성 custom 별칭만 worker 입력으로 허용한다."""
    metadata = get_custom_metadata()
    return is_preset(name) or (
        metadata is not None and name == metadata["original_name"]
    )


def get_active_model_name() -> str:
    """전역 기본 모델은 custom 유무와 무관하게 yolo26x로 고정한다."""
    return DEFAULT_MODEL


def get_active_model_names() -> list[str]:
    """source 요청에 사용할 고정 preset + 선택적 custom lane 이름."""
    metadata = get_custom_metadata()
    return [
        DEFAULT_MODEL,
        *([str(metadata["original_name"])] if metadata is not None else []),
    ]


def get_active_weights_status() -> dict:
    metadata = get_custom_metadata()
    return {
        "preset_name": DEFAULT_MODEL,
        "custom": None
        if metadata is None
        else {
            "name": metadata["original_name"],
            "uploaded_at": metadata["uploaded_at"],
            "size_mb": metadata["size_bytes"] / 1024 / 1024,
            "class_count": len(metadata["classes"]),
        },
    }


def list_all_models() -> list[dict]:
    """공식 preset과, 존재하면 현재 custom 하나를 반환한다."""
    models = [{"name": n, "type": "preset", "size_mb": None} for n in PRESET_MODELS]
    metadata = get_custom_metadata()
    if metadata is not None:
        models.append(
            {
                "name": metadata["original_name"],
                "type": "custom",
                "size_mb": metadata["size_bytes"] / 1024 / 1024,
            }
        )
    return models


def list_model_classes(name: str) -> list[dict]:
    """preset 모델의 COCO 클래스 메타데이터를 가중치 로드 없이 반환한다."""
    if not is_preset(name):
        raise ValueError(f"허용되지 않은 모델: {name!r} (preset 만 가능)")
    return [
        {"id": class_id, "name": class_name}
        for class_id, class_name in enumerate(COCO_CLASS_NAMES)
    ]


def list_active_classes() -> list[dict]:
    metadata = get_custom_metadata()
    if metadata is None:
        raise ValueError("custom 가중치가 없습니다")
    return list(metadata["classes"])


def extract_model_classes(path: Path) -> list[dict]:
    """custom 모델 names를 격리 subprocess에서 읽는다."""
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


def activate_custom_weights(
    temporary_path: Path,
    *,
    original_name: str,
    size_bytes: int,
    classes: list[dict],
) -> dict:
    """검증된 임시파일을 고정 custom 경로로 원자 교체하고 메타데이터를 기록한다."""
    directory = _weights_dir()
    directory.mkdir(parents=True, exist_ok=True)
    uploaded_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    metadata = {
        "original_name": Path(original_name).name,
        "uploaded_at": uploaded_at,
        "size_bytes": int(size_bytes),
        "classes": classes,
    }
    metadata_tmp = directory / ".custom.json.tmp"
    metadata_tmp.write_text(
        json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary_path, custom_weights_path())
    os.replace(metadata_tmp, custom_metadata_path())
    return metadata


def delete_custom_weights() -> None:
    custom_weights_path().unlink(missing_ok=True)
    custom_metadata_path().unlink(missing_ok=True)


def resolve_model_path(name: str) -> str:
    """worker 모델 이름을 preset 이름 또는 고정 custom 파일 하나로 해석한다."""
    metadata = get_custom_metadata()
    if metadata is not None and name == metadata["original_name"]:
        return str(custom_weights_path())
    if is_preset(name):
        return name
    raise ValueError(f"허용되지 않은 모델: {name!r}")
