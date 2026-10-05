"""worker·manager 배선 — 레인 id 가 worker 모델 키다."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app import config
from app.inference import models_dir
from app.inference.worker import Detection, InferenceResult, InferenceWorker
from app.streaming.manager import StreamManager, detections_to_json


@pytest.fixture()
def weights_dir(monkeypatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(config, "WEIGHTS_DIR", tmp_path)
    return tmp_path


def _write_target_slot(directory: Path, original_name: str = "warehouse.pt") -> None:
    (directory / "target.pt").write_bytes(b"weights")
    (directory / "target.json").write_text(
        json.dumps(
            {
                "original_name": original_name,
                "uploaded_at": "2026-09-08T01:02:03Z",
                "size_bytes": 7,
                "classes": [{"id": 0, "name": "forklift"}],
            }
        ),
        encoding="utf-8",
    )


def test_worker_defaults_to_the_anchor_lane(weights_dir: Path) -> None:
    worker = InferenceWorker()

    assert worker.get_status()["model"] == models_dir.DEFAULT_LANE == "anchor"


def test_configure_models_keeps_active_lanes_only(weights_dir: Path) -> None:
    _write_target_slot(weights_dir)
    worker = InferenceWorker()

    worker.configure_models({"anchor", "target", "warehouse.pt", "../escape.pt"})

    assert worker.get_pool_status()["models"] == ["anchor", "target"]


def test_uploaded_slot_survives_restart_as_the_same_lane_name(weights_dir: Path) -> None:
    _write_target_slot(weights_dir, "persisted.pt")

    assert models_dir.get_active_lanes() == ["anchor", "target"]
    assert models_dir.get_lane_status("target")["name"] == "persisted.pt"
    assert StreamManager().get_source_models("ipcam-after-restart") == ["anchor", "target"]


def test_reload_model_recreates_the_same_named_lane(weights_dir: Path) -> None:
    _write_target_slot(weights_dir)
    worker = InferenceWorker()

    class ExistingLane:
        stopped = False

        def stop(self) -> None:
            self.stopped = True

    existing = ExistingLane()
    worker._desired_models = {"anchor", "target"}
    worker._lanes["target"] = existing  # type: ignore[assignment]

    worker.reload_model("target")

    assert existing.stopped
    assert worker._lanes.get("target") is not existing
    assert worker.get_pool_status()["models"] == ["anchor", "target"]


def test_all_source_models_recalculate_to_the_active_lane_set(weights_dir: Path) -> None:
    manager = StreamManager()
    manager._per_source_models = {"ipcam-a": ["anchor"], "ipcam-b": []}
    manager._recompute_cadence = MagicMock()  # type: ignore[method-assign]

    manager.set_all_source_models(["anchor", "target"])

    assert manager._per_source_models == {
        "ipcam-a": ["anchor", "target"],
        "ipcam-b": ["anchor", "target"],
    }
    assert manager._default_source_models == ["anchor", "target"]
    manager._recompute_cadence.assert_called_once()


def test_detection_payload_preserves_lane_ids() -> None:
    payload = json.loads(
        detections_to_json(
            InferenceResult(
                source_id="ipcam-a",
                timestamp=1.0,
                frame_w=640,
                frame_h=360,
                detections=[
                    Detection(0, "person", 0.9, (0, 0, 10, 20), "anchor"),
                    Detection(0, "forklift", 0.8, (20, 0, 40, 20), "target"),
                ],
            )
        )
    )

    assert [item["model"] for item in payload["items"]] == ["anchor", "target"]
