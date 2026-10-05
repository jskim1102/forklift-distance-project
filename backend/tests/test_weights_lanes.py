"""레인 슬롯 저장 계층 계약 — anchor·target 대칭, preset fallback, 레거시 이관."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import config
from app.inference import models_dir


@pytest.fixture()
def weights_dir(monkeypatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(config, "WEIGHTS_DIR", tmp_path)
    return tmp_path


def _write_slot(directory: Path, lane: str, *, original_name: str, classes: list[dict]) -> None:
    (directory / f"{lane}.pt").write_bytes(b"weights")
    (directory / f"{lane}.json").write_text(
        json.dumps(
            {
                "original_name": original_name,
                "uploaded_at": "2026-09-08T00:00:00Z",
                "size_bytes": 7,
                "classes": classes,
            }
        ),
        encoding="utf-8",
    )


def test_empty_anchor_slot_falls_back_to_preset(weights_dir: Path) -> None:
    status = models_dir.get_lane_status("anchor")

    assert status == {
        "lane": "anchor",
        "source": "preset",
        "name": "yolo26x.pt",
        "uploaded_at": None,
        "size_mb": None,
        "class_count": 80,
    }
    assert models_dir.resolve_model_path("anchor") == "yolo26x.pt"
    assert models_dir.list_lane_classes("anchor")[0] == {"id": 0, "name": "person"}
    assert len(models_dir.list_lane_classes("anchor")) == 80


def test_empty_target_slot_is_inactive_and_has_no_classes(weights_dir: Path) -> None:
    assert models_dir.get_lane_status("target") is None
    assert models_dir.get_active_lanes() == ["anchor"]
    assert models_dir.get_all_lane_status() == {
        "anchor": models_dir.get_lane_status("anchor"),
        "target": None,
    }
    assert not models_dir.is_allowed_model("target")
    with pytest.raises(ValueError):
        models_dir.list_lane_classes("target")
    with pytest.raises(ValueError):
        models_dir.resolve_model_path("target")


def test_anchor_upload_replaces_slot_atomically(weights_dir: Path) -> None:
    temporary = weights_dir / ".upload-anchor.pt"
    temporary.write_bytes(b"anchor-bytes")

    metadata = models_dir.activate_lane_weights(
        temporary,
        lane="anchor",
        original_name="site.pt",
        size_bytes=12,
        classes=[{"id": 0, "name": "forklift"}],
    )

    assert metadata["original_name"] == "site.pt"
    assert not temporary.exists()
    assert (weights_dir / "anchor.pt").read_bytes() == b"anchor-bytes"
    assert models_dir.resolve_model_path("anchor") == str(weights_dir / "anchor.pt")
    assert models_dir.get_lane_status("anchor") == {
        "lane": "anchor",
        "source": "upload",
        "name": "site.pt",
        "uploaded_at": metadata["uploaded_at"],
        "size_mb": 12 / 1024 / 1024,
        "class_count": 1,
    }
    assert models_dir.list_lane_classes("anchor") == [{"id": 0, "name": "forklift"}]


def test_both_lanes_accept_the_same_original_filename(weights_dir: Path) -> None:
    for lane, payload in (("anchor", b"anchor-best"), ("target", b"target-best")):
        temporary = weights_dir / f".upload-{lane}.pt"
        temporary.write_bytes(payload)
        models_dir.activate_lane_weights(
            temporary,
            lane=lane,
            original_name="best.pt",
            size_bytes=len(payload),
            classes=[{"id": 0, "name": lane}],
        )

    assert (weights_dir / "anchor.pt").read_bytes() == b"anchor-best"
    assert (weights_dir / "target.pt").read_bytes() == b"target-best"
    assert models_dir.get_lane_status("anchor")["name"] == "best.pt"
    assert models_dir.get_lane_status("target")["name"] == "best.pt"
    assert models_dir.resolve_model_path("anchor") == str(weights_dir / "anchor.pt")
    assert models_dir.resolve_model_path("target") == str(weights_dir / "target.pt")
    assert models_dir.get_active_lanes() == ["anchor", "target"]


def test_preset_filename_is_accepted_as_an_uploaded_lane_name(weights_dir: Path) -> None:
    temporary = weights_dir / ".upload.pt"
    temporary.write_bytes(b"weights")

    models_dir.activate_lane_weights(
        temporary,
        lane="target",
        original_name="yolo26x.pt",
        size_bytes=7,
        classes=[{"id": 0, "name": "pallet"}],
    )

    assert models_dir.get_lane_status("target")["name"] == "yolo26x.pt"
    assert models_dir.resolve_model_path("target") == str(weights_dir / "target.pt")


def test_delete_returns_anchor_to_preset_and_target_to_inactive(weights_dir: Path) -> None:
    _write_slot(weights_dir, "anchor", original_name="a.pt", classes=[{"id": 0, "name": "a"}])
    _write_slot(weights_dir, "target", original_name="t.pt", classes=[{"id": 1, "name": "t"}])

    models_dir.delete_lane_weights("anchor")
    models_dir.delete_lane_weights("target")

    assert not (weights_dir / "anchor.pt").exists()
    assert not (weights_dir / "anchor.json").exists()
    assert not (weights_dir / "target.pt").exists()
    assert not (weights_dir / "target.json").exists()
    assert models_dir.get_lane_status("anchor")["source"] == "preset"
    assert models_dir.get_lane_status("target") is None
    assert models_dir.get_active_lanes() == ["anchor"]


def test_legacy_custom_slot_migrates_to_target_and_is_idempotent(weights_dir: Path) -> None:
    (weights_dir / "custom.pt").write_bytes(b"legacy")
    (weights_dir / "custom.json").write_text(
        json.dumps(
            {
                "original_name": "warehouse.pt",
                "uploaded_at": "2026-08-18T00:00:00Z",
                "size_bytes": 6,
                "classes": [{"id": 0, "name": "forklift"}],
            }
        ),
        encoding="utf-8",
    )

    first = models_dir.get_lane_metadata("target")
    second = models_dir.get_lane_metadata("target")

    assert first == second
    assert first["original_name"] == "warehouse.pt"
    assert (weights_dir / "target.pt").read_bytes() == b"legacy"
    assert not (weights_dir / "custom.pt").exists()
    assert not (weights_dir / "custom.json").exists()
    assert models_dir.get_active_lanes() == ["anchor", "target"]


def test_legacy_custom_slot_is_ignored_when_target_already_exists(weights_dir: Path) -> None:
    _write_slot(weights_dir, "target", original_name="current.pt", classes=[{"id": 3, "name": "box"}])
    (weights_dir / "custom.pt").write_bytes(b"legacy")
    (weights_dir / "custom.json").write_text(
        json.dumps(
            {
                "original_name": "legacy.pt",
                "uploaded_at": "2026-08-18T00:00:00Z",
                "size_bytes": 6,
                "classes": [{"id": 0, "name": "forklift"}],
            }
        ),
        encoding="utf-8",
    )

    assert models_dir.get_lane_metadata("target")["original_name"] == "current.pt"
    assert (weights_dir / "custom.pt").read_bytes() == b"legacy"
    assert (weights_dir / "custom.json").is_file()


@pytest.mark.parametrize("failed_filename", ["custom.json", "custom.pt"])
def test_interrupted_legacy_migration_stays_inactive_and_retries_without_data_loss(
    weights_dir: Path, monkeypatch, failed_filename: str
) -> None:
    _write_slot(
        weights_dir, "custom", original_name="best.pt", classes=[{"id": 0, "name": "forklift"}]
    )
    original_metadata = (weights_dir / "custom.json").read_bytes()
    replace = models_dir.os.replace
    moves = []

    def interrupted_replace(source: Path, destination: Path) -> None:
        moves.append(source.name)
        if source.name == failed_filename:
            raise OSError("interrupted migration")
        replace(source, destination)

    monkeypatch.setattr(models_dir.os, "replace", interrupted_replace)

    assert models_dir.get_lane_status("target") is None
    assert moves == (
        ["custom.json"] if failed_filename == "custom.json" else ["custom.json", "custom.pt"]
    )
    assert (weights_dir / "custom.pt").read_bytes() == b"weights"
    assert not (weights_dir / "target.pt").exists()
    metadata_name = "custom.json" if failed_filename == "custom.json" else "target.json"
    assert (weights_dir / metadata_name).read_bytes() == original_metadata

    monkeypatch.setattr(models_dir.os, "replace", replace)

    assert models_dir.get_lane_status("target")["name"] == "best.pt"
    assert models_dir.get_active_lanes() == ["anchor", "target"]
    assert (weights_dir / "target.pt").read_bytes() == b"weights"
    assert (weights_dir / "target.json").read_bytes() == original_metadata
    assert not (weights_dir / "custom.pt").exists()
    assert not (weights_dir / "custom.json").exists()


def test_half_written_slots_are_treated_as_inactive(weights_dir: Path) -> None:
    (weights_dir / "target.pt").write_bytes(b"weights")

    assert models_dir.get_lane_metadata("target") is None
    assert models_dir.get_lane_status("target") is None

    (weights_dir / "target.pt").unlink()
    (weights_dir / "target.json").write_text(
        json.dumps(
            {
                "original_name": "orphan.pt",
                "uploaded_at": "2026-08-18T00:00:00Z",
                "size_bytes": 6,
                "classes": [{"id": 0, "name": "forklift"}],
            }
        ),
        encoding="utf-8",
    )

    assert models_dir.get_lane_metadata("target") is None
    assert models_dir.get_lane_status("target") is None

    (weights_dir / "anchor.json").write_text("not json", encoding="utf-8")
    (weights_dir / "anchor.pt").write_bytes(b"weights")

    assert models_dir.get_lane_metadata("anchor") is None
    assert models_dir.get_lane_status("anchor")["source"] == "preset"


def test_only_lane_ids_resolve_to_worker_models(weights_dir: Path) -> None:
    _write_slot(weights_dir, "target", original_name="site.pt", classes=[{"id": 0, "name": "forklift"}])

    assert models_dir.is_lane("anchor")
    assert models_dir.is_lane("target")
    assert not models_dir.is_lane("custom")
    assert models_dir.is_allowed_model("anchor")
    assert models_dir.is_allowed_model("target")
    for rejected in ("yolo26x.pt", "site.pt", "custom.pt", "../escape.pt", "/tmp/site.pt"):
        assert not models_dir.is_allowed_model(rejected)
        with pytest.raises(ValueError):
            models_dir.resolve_model_path(rejected)


def test_preset_catalog_stays_independent_of_lanes(weights_dir: Path) -> None:
    assert models_dir.list_all_models() == [
        {"name": name, "type": "preset", "size_mb": None} for name in models_dir.PRESET_MODELS
    ]
    assert models_dir.is_preset("yolo26n.pt")
    assert not models_dir.is_preset("anchor")
    assert len(models_dir.list_model_classes("yolo26n.pt")) == 80
