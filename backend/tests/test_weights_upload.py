"""레인 가중치 API 계약 (/api/inference/weights, /api/inference/lanes/*)."""

from __future__ import annotations

import asyncio
import json
import subprocess
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.testclient import TestClient

from app import config, inference_api
from app.inference import models_dir

PRESET_ANCHOR = {
    "lane": "anchor",
    "source": "preset",
    "name": "yolo26x.pt",
    "uploaded_at": None,
    "size_mb": None,
    "class_count": 80,
}
PRESET_TARGET = {**PRESET_ANCHOR, "lane": "target"}


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


def _upload(http: TestClient, lane: str, filename: str, payload: bytes = b"model-bytes"):
    return http.post(
        f"/api/inference/lanes/{lane}/weights",
        files={"file": (filename, payload, "application/octet-stream")},
    )


def test_default_status_reports_two_preset_lanes_and_their_classes(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
) -> None:
    http, _set_model, _set_all_sources, _reload_model = client

    response = http.get("/api/inference/weights")

    assert response.status_code == 200
    assert response.json() == {"lanes": {"anchor": PRESET_ANCHOR, "target": PRESET_TARGET}}
    for lane in ("anchor", "target"):
        classes_response = http.get(f"/api/inference/lanes/{lane}/classes")
        assert classes_response.status_code == 200
        assert len(classes_response.json()) == 80
        assert classes_response.json()[0] == {"id": 0, "name": "person"}


def test_target_upload_persists_slot_and_activates_both_lanes(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    weights_dir: Path,
) -> None:
    http, set_model, set_all_sources, reload_model = client

    response = _upload(http, "target", "warehouse-v3.pt")

    assert response.status_code == 200
    body = response.json()
    assert body["lanes"]["anchor"] == PRESET_ANCHOR
    target = body["lanes"]["target"]
    assert target["source"] == "upload"
    assert target["name"] == "warehouse-v3.pt"
    assert target["class_count"] == 2
    assert target["size_mb"] == pytest.approx(len(b"model-bytes") / 1024 / 1024)
    assert target["uploaded_at"].endswith("Z")
    assert (weights_dir / "target.pt").read_bytes() == b"model-bytes"
    assert json.loads((weights_dir / "target.json").read_text(encoding="utf-8")) == {
        "original_name": "warehouse-v3.pt",
        "uploaded_at": target["uploaded_at"],
        "size_bytes": len(b"model-bytes"),
        "classes": [{"id": 0, "name": "forklift"}, {"id": 4, "name": "pallet"}],
    }
    set_model.assert_not_called()
    reload_model.assert_called_once_with("target")
    set_all_sources.assert_called_once_with(["anchor", "target"])
    assert http.get("/api/inference/weights").json() == body
    assert http.get("/api/inference/lanes/target/classes").json() == [
        {"id": 0, "name": "forklift"},
        {"id": 4, "name": "pallet"},
    ]


def test_anchor_upload_replaces_preset_without_renaming_the_lane(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    weights_dir: Path,
) -> None:
    http, _set_model, set_all_sources, reload_model = client

    response = _upload(http, "anchor", "site.pt", b"anchor-bytes")

    assert response.status_code == 200
    anchor = response.json()["lanes"]["anchor"]
    assert anchor["source"] == "upload"
    assert anchor["name"] == "site.pt"
    assert (weights_dir / "anchor.pt").read_bytes() == b"anchor-bytes"
    reload_model.assert_called_once_with("anchor")
    set_all_sources.assert_called_once_with(["anchor", "target"])
    assert http.get("/api/inference/lanes/anchor/classes").json() == [
        {"id": 0, "name": "forklift"},
        {"id": 4, "name": "pallet"},
    ]


def test_both_lanes_accept_the_same_filename_and_preset_names(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    weights_dir: Path,
) -> None:
    http, _set_model, _set_all_sources, _reload_model = client

    assert _upload(http, "anchor", "best.pt", b"anchor-best").status_code == 200
    response = _upload(http, "target", "best.pt", b"target-best")

    assert response.status_code == 200
    lanes = response.json()["lanes"]
    assert lanes["anchor"]["name"] == "best.pt"
    assert lanes["target"]["name"] == "best.pt"
    assert (weights_dir / "anchor.pt").read_bytes() == b"anchor-best"
    assert (weights_dir / "target.pt").read_bytes() == b"target-best"
    assert _upload(http, "target", "yolo26x.pt", b"preset-name").status_code == 200
    assert http.get("/api/inference/weights").json()["lanes"]["target"]["name"] == "yolo26x.pt"


def test_unknown_lane_is_rejected_on_every_lane_endpoint(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
) -> None:
    http, _set_model, set_all_sources, reload_model = client

    assert http.get("/api/inference/lanes/custom/classes").status_code == 404
    assert _upload(http, "custom", "x.pt").status_code == 404
    assert http.delete("/api/inference/lanes/custom/weights").status_code == 404
    set_all_sources.assert_not_called()
    reload_model.assert_not_called()


def test_target_delete_returns_to_preset_and_reloads_the_lane(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    weights_dir: Path,
) -> None:
    http, _set_model, set_all_sources, reload_model = client
    assert _upload(http, "target", "warehouse.pt").status_code == 200
    set_all_sources.reset_mock()
    reload_model.reset_mock()

    response = http.delete("/api/inference/lanes/target/weights")

    assert response.status_code == 200
    assert response.json() == {"lanes": {"anchor": PRESET_ANCHOR, "target": PRESET_TARGET}}
    assert not (weights_dir / "target.pt").exists()
    assert not (weights_dir / "target.json").exists()
    set_all_sources.assert_called_once_with(["anchor", "target"])
    reload_model.assert_called_once_with("target")
    assert len(http.get("/api/inference/lanes/target/classes").json()) == 80


def test_anchor_delete_returns_to_preset_and_reloads_the_surviving_lane(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    weights_dir: Path,
) -> None:
    http, _set_model, set_all_sources, reload_model = client
    assert _upload(http, "anchor", "site.pt").status_code == 200
    set_all_sources.reset_mock()
    reload_model.reset_mock()

    response = http.delete("/api/inference/lanes/anchor/weights")

    assert response.status_code == 200
    assert response.json()["lanes"]["anchor"] == PRESET_ANCHOR
    assert not (weights_dir / "anchor.pt").exists()
    reload_model.assert_called_once_with("anchor")
    set_all_sources.assert_called_once_with(["anchor", "target"])
    assert len(http.get("/api/inference/lanes/anchor/classes").json()) == 80


def test_invalid_extension_empty_and_oversized_uploads_leave_no_files(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    weights_dir: Path,
    monkeypatch,
) -> None:
    http, set_model, set_all_sources, reload_model = client

    assert _upload(http, "target", "weights.onnx", b"not-pt").status_code == 400
    assert _upload(http, "target", "empty.pt", b"").status_code == 400

    monkeypatch.setattr(models_dir, "MAX_UPLOAD_BYTES", 3)
    assert _upload(http, "target", "too-large.pt", b"1234").status_code == 400

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

    response = _upload(http, "anchor", "broken.pt", b"bad")

    assert response.status_code == 400
    assert list(weights_dir.iterdir()) == []
    set_model.assert_not_called()
    set_all_sources.assert_not_called()
    reload_model.assert_not_called()


def test_inference_config_rejects_model_even_for_uploaded_active_lane(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
) -> None:
    http, set_model, _set_all_sources, _reload_model = client

    assert http.patch("/api/inference", json={"model": "anchor"}).status_code == 404
    assert http.put("/api/inference/config", json={"model": "yolo26x.pt"}).status_code == 400
    assert http.put("/api/inference/config", json={"model": "target"}).status_code == 400
    set_model.assert_not_called()

    assert http.put("/api/inference/config", json={"model": "anchor"}).status_code == 400

    assert _upload(http, "target", "warehouse.pt").status_code == 200
    assert http.put("/api/inference/config", json={"model": "target"}).status_code == 400
    set_model.assert_not_called()


@pytest.mark.parametrize("rejected_model", ["anchor", "target", "yolo26x.pt", "unknown", None])
def test_rejected_model_does_not_change_inference_state(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock],
    monkeypatch,
    rejected_model: str | None,
) -> None:
    http, set_model, _set_all_sources, _reload_model = client
    set_enabled = MagicMock()
    set_conf = MagicMock()
    set_gpu = MagicMock()
    monkeypatch.setattr(inference_api.stream_manager, "set_inference_enabled", set_enabled)
    monkeypatch.setattr(inference_api.stream_manager, "set_inference_conf_threshold", set_conf)
    monkeypatch.setattr(inference_api.stream_manager, "set_gpu_util_target", set_gpu)

    response = http.put(
        "/api/inference/config", json={
            "enabled": False, "model": rejected_model, "conf_threshold": 0.6, "gpu_util_target": 0.5,
        }
    )

    assert response.status_code == 400
    set_enabled.assert_not_called()
    set_conf.assert_not_called()
    set_gpu.assert_not_called()
    set_model.assert_not_called()


def test_inference_config_still_accepts_updates_without_model(
    client: tuple[TestClient, MagicMock, MagicMock, MagicMock], monkeypatch,
) -> None:
    http, set_model, _set_all_sources, _reload_model = client
    set_enabled = MagicMock()
    set_conf = MagicMock()
    set_gpu = MagicMock()
    monkeypatch.setattr(inference_api.stream_manager, "set_inference_enabled", set_enabled)
    monkeypatch.setattr(inference_api.stream_manager, "set_inference_conf_threshold", set_conf)
    monkeypatch.setattr(inference_api.stream_manager, "set_gpu_util_target", set_gpu)

    response = http.put("/api/inference/config", json={
        "enabled": False, "conf_threshold": 0.6, "gpu_util_target": 0.5,
    })

    assert response.status_code == 200
    set_enabled.assert_called_once_with(False)
    set_conf.assert_called_once_with(0.6)
    set_gpu.assert_called_once_with(0.5)
    set_model.assert_not_called()


def test_invalid_extension_closes_the_upload_before_raising(weights_dir: Path) -> None:
    upload = UploadFile(filename="weights.onnx", file=BytesIO(b"not-pt"))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(inference_api.upload_lane_weights("target", upload))

    assert exc.value.status_code == 400
    assert upload.file.closed
    assert list(weights_dir.iterdir()) == []


def test_extract_model_classes_runs_ultralytics_in_short_subprocess(
    monkeypatch, tmp_path: Path
) -> None:
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
