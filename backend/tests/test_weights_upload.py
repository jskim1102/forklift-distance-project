"""시스템 전역 YOLO 가중치 업로드 계약."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config, inference_api
from app.inference import models_dir
from app.inference.worker import Detection, InferenceResult, InferenceWorker
from app.streaming.manager import StreamManager, detections_to_json


@pytest.fixture()
def weights_dir(monkeypatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(config, "WEIGHTS_DIR", tmp_path)
    return tmp_path


@pytest.fixture()
def client(
    monkeypatch,
    weights_dir: Path,
) -> tuple[TestClient, MagicMock, MagicMock, MagicMock]:
    classes = [{"id": 0, "name": "forklift"}, {"id": 4, "name": "pallet"}]
    monkeypatch.setattr(models_dir, "extract_model_classes", lambda _path: classes)

    set_model = MagicMock()
    set_all_sources = MagicMock()
    reload_model = MagicMock()
    monkeypatch.setattr(inference_api.stream_manager, "set_inference_model", set_model)
    monkeypatch.setattr(
        inference_api.stream_manager,
        "set_all_source_models",
        set_all_sources,
        raising=False,
    )
    monkeypatch.setattr(
        inference_api.stream_manager,
        "reload_source_model",
        reload_model,
        raising=False,
    )

    app = FastAPI()
    app.include_router(inference_api.inference_router)
    return TestClient(app), set_model, set_all_sources, reload_model


def test_default_weights_status_uses_fixed_yolo26x_and_has_no_custom_classes(
    weights_dir: Path,
) -> None:
    status = models_dir.get_active_weights_status()

    assert status == {
        "preset_name": "yolo26x.pt",
        "custom": None,
    }
    assert models_dir.get_active_model_name() == "yolo26x.pt"
    assert models_dir.get_active_model_names() == ["yolo26x.pt"]
    with pytest.raises(ValueError, match="custom"):
        models_dir.list_active_classes()


def test_upload_persists_custom_weights_and_activates_dual_source_models(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    weights_dir: Path,
) -> None:
    http, set_model, set_all_sources, reload_model = client

    response = http.post(
        "/api/inference/weights",
        files={"file": ("warehouse-v3.pt", b"model-bytes", "application/octet-stream")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["preset_name"] == "yolo26x.pt"
    assert body["custom"]["name"] == "warehouse-v3.pt"
    assert body["custom"]["class_count"] == 2
    assert body["custom"]["size_mb"] == pytest.approx(
        len(b"model-bytes") / 1024 / 1024
    )
    assert body["custom"]["uploaded_at"].endswith("Z")
    assert (weights_dir / "custom.pt").read_bytes() == b"model-bytes"
    metadata = json.loads((weights_dir / "custom.json").read_text(encoding="utf-8"))
    assert metadata == {
        "original_name": "warehouse-v3.pt",
        "uploaded_at": body["custom"]["uploaded_at"],
        "size_bytes": len(b"model-bytes"),
        "classes": [{"id": 0, "name": "forklift"}, {"id": 4, "name": "pallet"}],
    }
    set_model.assert_not_called()
    set_all_sources.assert_called_once_with(["yolo26x.pt", "warehouse-v3.pt"])
    reload_model.assert_called_once_with("warehouse-v3.pt")

    assert http.get("/api/inference/weights").json() == body
    assert http.get("/api/inference/classes").json() == metadata["classes"]
    assert models_dir.get_active_model_name() == "yolo26x.pt"
    assert models_dir.get_active_model_names() == ["yolo26x.pt", "warehouse-v3.pt"]
    assert models_dir.resolve_model_path("warehouse-v3.pt") == str(weights_dir / "custom.pt")
    assert http.put(
        "/api/inference/config",
        json={"model": "yolo26n.pt"},
    ).status_code == 400
    assert http.put(
        "/api/inference/config",
        json={"model": "warehouse-v3.pt"},
    ).status_code == 400


def test_non_default_preset_filename_can_be_uploaded_as_custom_weights(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    weights_dir: Path,
) -> None:
    http, _set_model, set_all_sources, reload_model = client

    response = http.post(
        "/api/inference/weights",
        files={"file": ("yolo26n.pt", b"custom-nano", "application/octet-stream")},
    )

    assert response.status_code == 200
    assert response.json()["custom"]["name"] == "yolo26n.pt"
    assert models_dir.get_active_model_names() == ["yolo26x.pt", "yolo26n.pt"]
    assert models_dir.resolve_model_path("yolo26n.pt") == str(weights_dir / "custom.pt")
    set_all_sources.assert_called_once_with(["yolo26x.pt", "yolo26n.pt"])
    reload_model.assert_called_once_with("yolo26n.pt")


def test_delete_custom_weights_keeps_preset_and_removes_custom_lane(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    weights_dir: Path,
) -> None:
    http, set_model, set_all_sources, reload_model = client
    assert http.post(
        "/api/inference/weights",
        files={"file": ("custom-model.pt", b"weights", "application/octet-stream")},
    ).status_code == 200
    set_model.reset_mock()
    set_all_sources.reset_mock()
    reload_model.reset_mock()

    response = http.delete("/api/inference/weights")

    assert response.status_code == 200
    assert response.json() == {"preset_name": "yolo26x.pt", "custom": None}
    assert not (weights_dir / "custom.pt").exists()
    assert not (weights_dir / "custom.json").exists()
    set_model.assert_not_called()
    set_all_sources.assert_called_once_with(["yolo26x.pt"])
    reload_model.assert_not_called()
    assert http.get("/api/inference/classes").status_code == 404


def test_invalid_extension_and_oversized_upload_leave_no_files(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    weights_dir: Path,
    monkeypatch,
) -> None:
    http, set_model, set_all_sources, reload_model = client

    response = http.post(
        "/api/inference/weights",
        files={"file": ("weights.onnx", b"not-pt", "application/octet-stream")},
    )
    assert response.status_code == 400

    response = http.post(
        "/api/inference/weights",
        files={"file": ("yolo26x.pt", b"alias-collision", "application/octet-stream")},
    )
    assert response.status_code == 400
    assert "고정 person 모델 yolo26x.pt" in response.json()["detail"]

    monkeypatch.setattr(models_dir, "MAX_UPLOAD_BYTES", 3)
    response = http.post(
        "/api/inference/weights",
        files={"file": ("too-large.pt", b"1234", "application/octet-stream")},
    )
    assert response.status_code == 400
    assert list(weights_dir.iterdir()) == []
    set_model.assert_not_called()
    set_all_sources.assert_not_called()
    reload_model.assert_not_called()


def test_class_extraction_failure_removes_temporary_upload(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    weights_dir: Path,
    monkeypatch,
) -> None:
    http, set_model, set_all_sources, reload_model = client

    def fail_extract(_path: Path) -> list[dict]:
        raise ValueError("not a detection model")

    monkeypatch.setattr(models_dir, "extract_model_classes", fail_extract)
    response = http.post(
        "/api/inference/weights",
        files={"file": ("broken.pt", b"bad", "application/octet-stream")},
    )

    assert response.status_code == 400
    assert list(weights_dir.iterdir()) == []
    set_model.assert_not_called()
    set_all_sources.assert_not_called()
    reload_model.assert_not_called()


def test_extract_model_classes_runs_ultralytics_in_short_subprocess(monkeypatch, tmp_path: Path) -> None:
    weight_path = tmp_path / "candidate.pt"
    weight_path.write_bytes(b"weights")
    completed = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout='ultralytics log\n[{"id": 2, "name": "car"}]\n',
        stderr="",
    )
    run = MagicMock(return_value=completed)
    monkeypatch.setattr(models_dir.subprocess, "run", run)

    assert models_dir.extract_model_classes(weight_path) == [{"id": 2, "name": "car"}]
    command = run.call_args.args[0]
    assert command[-1] == str(weight_path)
    assert "ultralytics" in command[2]
    assert run.call_args.kwargs["timeout"] <= 60


def test_only_presets_and_the_active_custom_alias_can_resolve(weights_dir: Path) -> None:
    (weights_dir / "custom.pt").write_bytes(b"weights")
    (weights_dir / "custom.json").write_text(
        json.dumps(
            {
                "original_name": "site-model.pt",
                "uploaded_at": "2026-08-18T00:00:00Z",
                "size_bytes": 7,
                "classes": [{"id": 0, "name": "person"}],
            }
        ),
        encoding="utf-8",
    )

    assert models_dir.is_preset("yolo26n.pt")
    assert not models_dir.is_preset("site-model.pt")
    assert models_dir.is_allowed_model("site-model.pt")
    assert models_dir.resolve_model_path("site-model.pt") == str(weights_dir / "custom.pt")
    assert models_dir.resolve_model_path("yolo26n.pt") == "yolo26n.pt"
    for rejected in ("custom.pt", "/tmp/site-model.pt", "../site-model.pt", "other.pt"):
        assert not models_dir.is_allowed_model(rejected)
        with pytest.raises(ValueError):
            models_dir.resolve_model_path(rejected)


def test_existing_custom_metadata_restores_active_model_after_restart(weights_dir: Path) -> None:
    (weights_dir / "custom.pt").write_bytes(b"weights")
    (weights_dir / "custom.json").write_text(
        json.dumps(
            {
                "original_name": "persisted.pt",
                "uploaded_at": "2026-08-18T01:02:03Z",
                "size_bytes": 7,
                "classes": [{"id": 0, "name": "worker"}],
            }
        ),
        encoding="utf-8",
    )

    assert models_dir.get_active_model_name() == "yolo26x.pt"
    assert models_dir.get_active_model_names() == ["yolo26x.pt", "persisted.pt"]
    assert models_dir.get_active_weights_status()["custom"]["name"] == "persisted.pt"
    assert models_dir.list_active_classes() == [{"id": 0, "name": "worker"}]

    worker = InferenceWorker()
    assert worker.get_status()["model"] == "yolo26x.pt"
    worker.configure_models({"yolo26x.pt", "persisted.pt", "../escape.pt"})
    assert worker.get_pool_status()["models"] == ["persisted.pt", "yolo26x.pt"]

    manager = StreamManager()
    assert manager.get_source_models("ipcam-after-restart") == [
        "yolo26x.pt",
        "persisted.pt",
    ]


def test_reload_model_replaces_same_named_custom_worker_lane(weights_dir: Path) -> None:
    (weights_dir / "custom.pt").write_bytes(b"weights")
    (weights_dir / "custom.json").write_text(
        json.dumps(
            {
                "original_name": "site-model.pt",
                "uploaded_at": "2026-08-18T01:02:03Z",
                "size_bytes": 7,
                "classes": [{"id": 0, "name": "forklift"}],
            }
        ),
        encoding="utf-8",
    )
    worker = InferenceWorker(model_name="yolo26x.pt")

    class ExistingLane:
        stopped = False

        def stop(self) -> None:
            self.stopped = True

    existing = ExistingLane()
    worker._desired_models = {"yolo26x.pt", "site-model.pt"}
    worker._lanes["site-model.pt"] = existing  # type: ignore[assignment]
    worker.reload_model("site-model.pt")

    assert existing.stopped
    assert worker._lanes.get("site-model.pt") is not existing
    assert worker.get_pool_status()["models"] == ["site-model.pt", "yolo26x.pt"]


def test_all_source_models_recalculate_to_the_dual_active_set(weights_dir: Path) -> None:
    manager = StreamManager()
    manager._per_source_models = {
        "ipcam-a": ["yolo26n.pt"],
        "ipcam-b": [],
    }
    manager._recompute_cadence = MagicMock()  # type: ignore[method-assign]

    manager.set_all_source_models(["yolo26x.pt", "active.pt"])

    assert manager._per_source_models == {
        "ipcam-a": ["yolo26x.pt", "active.pt"],
        "ipcam-b": ["yolo26x.pt", "active.pt"],
    }
    assert manager._default_source_models == ["yolo26x.pt", "active.pt"]
    manager._recompute_cadence.assert_called_once()


def test_detection_payload_preserves_each_lane_model_name() -> None:
    payload = json.loads(
        detections_to_json(
            InferenceResult(
                source_id="ipcam-a",
                timestamp=1.0,
                frame_w=640,
                frame_h=360,
                detections=[
                    Detection(0, "person", 0.9, (0, 0, 10, 20), "yolo26x.pt"),
                    Detection(0, "forklift", 0.8, (20, 0, 40, 20), "warehouse.pt"),
                ],
            )
        )
    )

    assert [item["model"] for item in payload["items"]] == [
        "yolo26x.pt",
        "warehouse.pt",
    ]
