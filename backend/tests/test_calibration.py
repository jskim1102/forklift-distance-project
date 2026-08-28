"""calibration core characterization 테스트.

calibration.py 는 prime 에서 extract 한 supplied 코드(near-verbatim) → 동작을 고정
(characterization). 검증·homography·pixel_to_world 의 기존 출력을 핀고정한다.

검증 실패(공선/길이불일치/중복)는 core 레벨에선 pydantic ValidationError 로 난다 —
이것이 API 레벨에서 400 으로 매핑되는 건 test_calibration_api.py(ckpt3) 에서 확인.
"""

import math

import pytest
from pydantic import ValidationError

from app.calibration import (
    CalibrationUpdate,
    _compute_homography,
    _default_calibration_state,
    pixel_to_world,
)


# 검증된 production-path 12점. world 좌표는 저장된 calibration 의 full precision 을
# 사용해 기존 k1=0 reprojection 벡터/평균(7.78px)을 정확히 고정한다.
_LENS_PIXEL_POINTS = [
    [825, 988], [1504, 809], [757, 677], [1283, 593],
    [726, 509], [1136, 462], [705, 404], [1046, 372],
    [696, 344], [980, 319], [691, 298], [929, 278],
]
_LENS_WORLD_POINTS = [
    [0.0, 0.0],
    [1.8, 0.0],
    [1.2335811384723962e-16, 1.35],
    [1.8, 1.3499999999999999],
    [-6.9444444441815435e-06, 2.6999999999910695],
    [1.8000069444444442, 2.6999999999910695],
    [-3.4444444442844395e-05, 4.0499999998535285],
    [1.800034444444443, 4.0499999998535285],
    [-0.005683333333334792, 5.397997008124608],
    [1.7996844444444444, 5.399999990780064],
    [-0.0004711111111142961, 6.749999983559579],
    [1.8004711111111145, 6.749999983559579],
]
_LEGACY_REPROJECTION_ERRORS = [
    12.31, 32.39, 6.9, 11.12, 1.79, 6.86,
    7.12, 6.34, 1.01, 1.72, 2.01, 3.8,
]


def test_four_point_exact_fit_reprojection_near_zero():
    # 단위 정사각형(픽셀) → 동일 정사각형(월드). 4점 exact fit → reproj ≈ 0.
    pixel = [[0, 0], [100, 0], [100, 100], [0, 100]]
    world = [[0, 0], [1, 0], [1, 1], [0, 1]]
    result = _compute_homography(pixel, world)

    assert result.mean_reprojection_error < 1e-6
    assert all(e < 1e-6 for e in result.reprojection_errors)
    assert result.inlier_mask == [1, 1, 1, 1]  # 전부 "사용된 점"
    assert len(result.H) == 3 and len(result.H[0]) == 3


def test_compute_homography_then_pixel_to_world_roundtrip():
    # H fit 후 pixel_to_world 가 calibration 점을 월드로 정확히 보낸다.
    pixel = [[0, 0], [100, 0], [100, 100], [0, 100]]
    world = [[0, 0], [1, 0], [1, 1], [0, 1]]
    H = _compute_homography(pixel, world).H

    for (u, v), (wx, wy) in zip(pixel, world):
        out = pixel_to_world(H, u, v)
        assert out is not None
        assert math.isclose(out[0], wx, abs_tol=1e-6)
        assert math.isclose(out[1], wy, abs_tol=1e-6)


def test_pixel_to_world_none_homography_returns_none():
    assert pixel_to_world(None, 5, 5) is None


def test_fit_k1_reduces_verified_twelve_point_reprojection_error():
    legacy = _compute_homography(_LENS_PIXEL_POINTS, _LENS_WORLD_POINTS)
    corrected = _compute_homography(
        _LENS_PIXEL_POINTS,
        _LENS_WORLD_POINTS,
        native_size=[1920, 1080],
    )

    # 구클라이언트(native_size 없음)는 기존 산출을 byte-for-byte 유지한다.
    assert legacy.reprojection_errors == _LEGACY_REPROJECTION_ERRORS
    assert legacy.mean_reprojection_error == 7.78
    assert legacy.k1 == 0.0

    # 단일 k1 보정은 검증된 optimum 부근이며 clamp 범위 안에서 오차를 절반 이하로 낮춘다.
    assert 0.30 < corrected.k1 < 0.41
    assert 0.0 <= corrected.k1 <= 0.6
    assert corrected.mean_reprojection_error < 3.5


def test_fit_k1_gate_keeps_distortion_free_homography_at_zero():
    pixel = [[100, 100], [900, 100], [900, 700], [100, 700], [500, 300], [700, 500]]
    world = [[1, 1], [9, 1], [9, 7], [1, 7], [5, 3], [7, 5]]

    result = _compute_homography(pixel, world, native_size=[1000, 800])

    assert result.k1 == 0.0
    assert result.mean_reprojection_error < 1e-6


def test_fit_k1_is_clamped_at_safe_upper_bound():
    pixel = [
        [100, 100], [1820, 100], [1820, 980], [100, 980],
        [960, 100], [960, 980], [200, 540], [1720, 540],
    ]
    # k1=1.0 합성 대응점은 허용범위 밖 optimum을 요구한다. production fit은 0.6에서
    # 멈춰 과대 보정이 저장될 수 없게 해야 한다.
    world = []
    cx, cy, scale = 960.0, 540.0, 960.0
    for u, v in pixel:
        x = (u - cx) / scale
        y = (v - cy) / scale
        distortion = 1 + x * x + y * y
        world.append([x * distortion * scale + cx, y * distortion * scale + cy])

    result = _compute_homography(pixel, world, native_size=[1920, 1080])

    assert result.k1 == pytest.approx(0.6, abs=1e-5)


def test_pixel_to_world_applies_same_single_k1_formula_before_homography():
    H = [
        [0.02, 0.001, -3.0],
        [0.0005, 0.03, 2.0],
        [0.00001, -0.00002, 1.0],
    ]
    u, v = 1500.0, 800.0
    k1 = 0.35
    width, height = 1920.0, 1080.0
    cx, cy, scale = width / 2, height / 2, width / 2
    x = (u - cx) / scale
    y = (v - cy) / scale
    distortion = 1 + k1 * (x * x + y * y)
    corrected_u = x * distortion * scale + cx
    corrected_v = y * distortion * scale + cy

    expected = pixel_to_world(H, corrected_u, corrected_v)
    actual = pixel_to_world(H, u, v, k1=k1, native_size=[width, height])

    assert actual == pytest.approx(expected, abs=1e-12)
    assert pixel_to_world(H, u, v, k1=k1) == pixel_to_world(H, u, v)


def test_collinear_points_rejected():
    # 모든 픽셀 점이 한 직선 위 → ValidationError(_check_collinearity).
    with pytest.raises(ValidationError, match="직선"):
        CalibrationUpdate(
            pixel_points=[[0, 0], [1, 1], [2, 2], [3, 3]],
            world_points=[[0, 0], [1, 0], [2, 0], [0, 1]],
        )


def test_length_mismatch_rejected():
    with pytest.raises(ValidationError, match="길이"):
        CalibrationUpdate(
            pixel_points=[[0, 0], [1, 0], [1, 1], [0, 1]],
            world_points=[[0, 0], [1, 0], [1, 1]],
        )


def test_duplicate_points_rejected():
    with pytest.raises(ValidationError, match="중복"):
        CalibrationUpdate(
            pixel_points=[[0, 0], [1, 0], [1, 0], [0, 1]],
            world_points=[[0, 0], [1, 0], [1, 1], [0, 1]],
        )


def test_too_few_points_rejected():
    with pytest.raises(ValidationError, match="점 개수"):
        CalibrationUpdate(
            pixel_points=[[0, 0], [1, 0], [1, 1]],
            world_points=[[0, 0], [1, 0], [1, 1]],
        )


def test_default_calibration_state_shape():
    s = _default_calibration_state()
    assert s["enabled"] is False
    assert s["homography"] is None
    assert s["k1"] == 0.0
    assert s["native_size"] is None
    assert "threshold_m" not in s  # strip 확인
    # homography-only 계약 — 다항식 필드는 없다.
    assert not any(k.startswith("poly_") for k in s)
