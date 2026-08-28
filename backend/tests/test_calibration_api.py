"""calibration GET/PUT 엔드포인트 테스트.

prime endpoint(L401-446)에서 extract 한 GET/PUT 의 계약을 고정:
- GET: 미설정→default state, 없는 stream_key→404
- PUT: CalibrationUpdate→homography 산출·저장→CalibrationState 반환, 검증실패 400/422, 없는 key 404
"""

import os
import tempfile
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture()
def mtx():
    with patch("app.ipcam.register_stream") as register, \
         patch("app.ipcam.remove_stream") as remove:
        register.return_value = True
        yield {"register": register, "remove": remove}


@pytest.fixture()
def client(mtx):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    test_url = f"sqlite:///{path}"

    from app.database import Base, get_db
    from app.ipcam import router as ipcam_router

    app = FastAPI()
    app.include_router(ipcam_router)

    engine = create_engine(test_url, connect_args={"check_same_thread": False})
    TestSession = sessionmaker(bind=engine)
    Base.metadata.create_all(bind=engine)

    def _override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    engine.dispose()
    os.unlink(path)


def _make_cam(client) -> str:
    resp = client.post("/api/ipcams", json={"name": "cam", "rtsp_url": "rtsp://x/1"})
    assert resp.status_code == 201
    return resp.json()["stream_key"]


# 단위 정사각형(픽셀) → 동일 정사각형(월드) — 4점 exact fit.
_SQUARE_PX = [[0, 0], [100, 0], [100, 100], [0, 100]]
_SQUARE_WD = [[0, 0], [1, 0], [1, 1], [0, 1]]


def test_get_unset_returns_default_state(client):
    key = _make_cam(client)
    resp = client.get(f"/api/ipcams/{key}/calibration")
    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled"] is False
    assert body["homography"] is None
    assert body["k1"] == 0.0
    assert body["native_size"] is None
    # homography-only 계약 — 응답에 다항식 필드는 없다.
    assert not any(k.startswith("poly_") for k in body)


def test_get_unknown_key_404(client):
    resp = client.get("/api/ipcams/__nope__/calibration")
    assert resp.status_code == 404


def test_put_computes_and_persists_homography(client):
    key = _make_cam(client)
    resp = client.put(
        f"/api/ipcams/{key}/calibration",
        json={"pixel_points": _SQUARE_PX, "world_points": _SQUARE_WD, "enabled": True},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled"] is True
    assert len(body["homography"]) == 3 and len(body["homography"][0]) == 3
    assert body["mean_reprojection_error"] < 1e-6
    assert body["inlier_mask"] == [1, 1, 1, 1]
    assert body["k1"] == 0.0
    assert body["native_size"] is None
    # homography-only 계약 — 저장/반환에 다항식 필드는 없다.
    assert not any(k.startswith("poly_") for k in body)

    # GET 으로 영속 확인 — 저장된 H 가 그대로 복원된다.
    got = client.get(f"/api/ipcams/{key}/calibration").json()
    assert got["homography"] == body["homography"]
    assert got["enabled"] is True
    assert got["k1"] == 0.0
    assert got["native_size"] is None
    assert not any(k.startswith("poly_") for k in got)


def test_put_persists_native_size_and_fitted_k1(client):
    key = _make_cam(client)
    pixel = [
        [825, 988], [1504, 809], [757, 677], [1283, 593],
        [726, 509], [1136, 462], [705, 404], [1046, 372],
        [696, 344], [980, 319], [691, 298], [929, 278],
    ]
    world = [
        [0, 0], [1.8, 0], [0, 1.35], [1.8, 1.35],
        [0, 2.7], [1.8, 2.7], [0, 4.05], [1.8, 4.05],
        [-0.006, 5.398], [1.8, 5.4], [0, 6.75], [1.8, 6.75],
    ]

    resp = client.put(
        f"/api/ipcams/{key}/calibration",
        json={
            "pixel_points": pixel,
            "world_points": world,
            "enabled": True,
            "native_size": [1920, 1080],
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert 0.30 < body["k1"] < 0.41
    assert body["native_size"] == [1920.0, 1080.0]
    got = client.get(f"/api/ipcams/{key}/calibration").json()
    assert got["k1"] == body["k1"]
    assert got["native_size"] == body["native_size"]


def test_put_unknown_key_404(client):
    resp = client.put(
        "/api/ipcams/__nope__/calibration",
        json={"pixel_points": _SQUARE_PX, "world_points": _SQUARE_WD, "enabled": True},
    )
    assert resp.status_code == 404


def test_put_collinear_points_rejected(client):
    key = _make_cam(client)
    resp = client.put(
        f"/api/ipcams/{key}/calibration",
        json={
            "pixel_points": [[0, 0], [1, 1], [2, 2], [3, 3]],
            "world_points": _SQUARE_WD,
            "enabled": True,
        },
    )
    # pydantic 검증 실패 → 422 (FastAPI 기본 RequestValidationError).
    assert resp.status_code == 422


def test_put_length_mismatch_rejected(client):
    key = _make_cam(client)
    resp = client.put(
        f"/api/ipcams/{key}/calibration",
        json={
            "pixel_points": _SQUARE_PX,
            "world_points": [[0, 0], [1, 0], [1, 1]],
            "enabled": True,
        },
    )
    assert resp.status_code == 422
