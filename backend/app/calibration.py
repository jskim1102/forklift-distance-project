"""카메라별 거리측정 calibration core.

prime backend (ipcam.py L226-378 + inference/distance.py) 에서 extract.
사용자가 이미지 위 N점(4~12)의 픽셀↔월드 대응을 주면 단일 평면 homography 를
`cv2.findHomography` 로 fit 하고, 저장된 H 로 픽셀→월드 변환을 제공한다.

prime 대비 strip:
- `threshold_m`(거리경보용 — 본 모듈 non-goal) 필드/검증 제거.
- `set_source_calibration`(추론 스트리밍 파이프라인) — 본 모듈은 그 파이프라인 없음.
- inlier 의 outlier-alert 의미 — `cv2.findHomography(src, dst, 0)` 는 RANSAC 이 아니라
  least-squares 라 outlier 제거가 없다. `inlier_mask` 는 호환 위해 남기되 전부 1
  (의미 = "사용된 점").
"""

import numpy as np
import cv2
from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

_MIN_POINTS = 4
_MAX_POINTS = 12
_K1_MIN = 0.0
_K1_MAX = 0.6
_K1_GATE = 0.15
_GOLDEN_SECTION_TOLERANCE = 1e-5


class CalibrationState(BaseModel):
    """카메라별 거리측정 calibration 상태 — GET 응답 형식."""
    enabled: bool
    pixel_points: list[list[float]] | None = None
    world_points: list[list[float]] | None = None
    homography: list[list[float]] | None = None
    k1: float = 0.0
    native_size: list[float] | None = None
    reprojection_errors: list[float] | None = None
    mean_reprojection_error: float | None = None
    inlier_mask: list[int] | None = None


class CalibrationUpdate(BaseModel):
    """PUT 요청 — N점(4~12) pixel/world 좌표 + homography 산출."""
    pixel_points: list[list[float]]
    world_points: list[list[float]]
    enabled: bool = True
    # k1 은 서버가 native_size+기준점으로 다시 fit 한다. 필드는 GET state 를 그대로
    # PUT 하는 클라이언트와의 스키마 호환을 위한 입력 기본값이며 계산에는 사용하지 않는다.
    k1: float = Field(default=0.0, ge=_K1_MIN, le=_K1_MAX)
    native_size: list[float] | None = None

    @field_validator("pixel_points", "world_points")
    @classmethod
    def _each_point_must_be_2d(cls, v: list[list[float]]) -> list[list[float]]:
        for i, pt in enumerate(v):
            if len(pt) != 2:
                raise ValueError(f"점 {i}은(는) [x, y] 2개 값이어야 합니다 (받은 값: {len(pt)}개)")
        return v

    @field_validator("native_size")
    @classmethod
    def _native_size_must_be_positive_2d(
        cls, v: list[float] | None,
    ) -> list[float] | None:
        if v is None:
            return None
        if len(v) != 2 or any(not np.isfinite(x) or x <= 0 for x in v):
            raise ValueError("native_size는 양수 [width, height] 2개 값이어야 합니다")
        return [float(v[0]), float(v[1])]

    @model_validator(mode="after")
    def _validate_points(self) -> "CalibrationUpdate":
        n_px = len(self.pixel_points)
        n_wd = len(self.world_points)

        if n_px != n_wd:
            raise ValueError(
                f"pixel_points({n_px}개)와 world_points({n_wd}개)의 길이가 다릅니다"
            )
        if not (_MIN_POINTS <= n_px <= _MAX_POINTS):
            raise ValueError(
                f"점 개수는 {_MIN_POINTS}~{_MAX_POINTS}개여야 합니다 (받은 값: {n_px}개)"
            )

        px_tuples = [tuple(p) for p in self.pixel_points]
        if len(set(px_tuples)) != len(px_tuples):
            raise ValueError("pixel_points에 중복 좌표가 있습니다")

        wd_tuples = [tuple(p) for p in self.world_points]
        if len(set(wd_tuples)) != len(wd_tuples):
            raise ValueError("world_points에 중복 좌표가 있습니다")

        _check_collinearity(self.pixel_points, "pixel_points")
        _check_collinearity(self.world_points, "world_points")

        return self


def _check_collinearity(points: list[list[float]], name: str) -> None:
    """모든 점이 한 직선 위에 있으면 ValueError."""
    pts = np.array(points, dtype=np.float64)
    base = pts[0]
    v0 = pts[1] - base
    norm_v0 = np.linalg.norm(v0)
    if norm_v0 < 1e-9:
        raise ValueError(f"{name}의 처음 두 점이 동일합니다")
    v0 = v0 / norm_v0

    for i in range(2, len(pts)):
        vi = pts[i] - base
        cross = abs(v0[0] * vi[1] - v0[1] * vi[0])
        if cross > 1e-6:
            return
    raise ValueError(f"{name}의 모든 점이 한 직선 위에 있습니다 — homography 계산 불가")


def _default_calibration_state() -> dict:
    return {
        "enabled": False,
        "pixel_points": None,
        "world_points": None,
        "homography": None,
        "k1": 0.0,
        "native_size": None,
        "reprojection_errors": None,
        "mean_reprojection_error": None,
        "inlier_mask": None,
    }


class HomographyResult:
    __slots__ = ("H", "k1", "reprojection_errors", "mean_reprojection_error", "inlier_mask")

    def __init__(
        self,
        H: list[list[float]],
        k1: float,
        reprojection_errors: list[float],
        mean_reprojection_error: float,
        inlier_mask: list[int],
    ):
        self.H = H
        self.k1 = k1
        self.reprojection_errors = reprojection_errors
        self.mean_reprojection_error = mean_reprojection_error
        self.inlier_mask = inlier_mask


def _native_geometry(
    native_size: list[float] | tuple[float, float] | None,
) -> tuple[float, float, float] | None:
    """native [width,height]를 고정 중심 왜곡 파라미터(cx,cy,s)로 변환."""
    if native_size is None or len(native_size) != 2:
        return None
    width, height = float(native_size[0]), float(native_size[1])
    if not np.isfinite(width) or not np.isfinite(height) or width <= 0 or height <= 0:
        return None
    return width / 2.0, height / 2.0, width / 2.0


def _undistort_point(
    u: float,
    v: float,
    k1: float,
    native_size: list[float] | tuple[float, float] | None,
) -> tuple[float, float]:
    """검증 참조의 단일 k1 보정 규약을 한 점에 적용한다."""
    geometry = _native_geometry(native_size)
    if geometry is None or k1 == 0.0:
        return float(u), float(v)
    cx, cy, scale = geometry
    x = (float(u) - cx) / scale
    y = (float(v) - cy) / scale
    r2 = x * x + y * y
    distortion = 1.0 + float(k1) * r2
    return x * distortion * scale + cx, y * distortion * scale + cy


def _undistort_points(
    points: np.ndarray,
    k1: float,
    native_size: list[float] | tuple[float, float] | None,
) -> np.ndarray:
    """_undistort_point와 byte-identical한 공식을 Nx2 배열에 적용한다."""
    geometry = _native_geometry(native_size)
    src = np.asarray(points, dtype=np.float64)
    if geometry is None or k1 == 0.0:
        return src.copy()
    cx, cy, scale = geometry
    x = (src[:, 0] - cx) / scale
    y = (src[:, 1] - cy) / scale
    r2 = x * x + y * y
    distortion = 1.0 + float(k1) * r2
    return np.stack(
        [x * distortion * scale + cx, y * distortion * scale + cy],
        axis=1,
    )


def _mean_reprojection_error(src: np.ndarray, dst: np.ndarray) -> float:
    """production H estimator와 같은 world→pixel 평균 오차. 실패는 +inf."""
    H, _ = cv2.findHomography(src, dst, 0)
    if H is None or abs(float(np.linalg.det(H))) < 1e-10:
        return float("inf")
    try:
        H_inv = np.linalg.inv(H)
        reproj = cv2.perspectiveTransform(dst.reshape(-1, 1, 2), H_inv)
    except (cv2.error, np.linalg.LinAlgError):
        return float("inf")
    errors = np.linalg.norm(reproj.reshape(-1, 2) - src, axis=1)
    mean = float(errors.mean())
    return mean if np.isfinite(mean) else float("inf")


def _fit_k1(
    pixel_points: list[list[float]],
    world_points: list[list[float]],
    native_size: list[float] | tuple[float, float] | None,
) -> float:
    """고정 중심 단일 k1을 golden-section으로 fit하고 clamp+gate한다."""
    if len(pixel_points) < 5 or _native_geometry(native_size) is None:
        return 0.0

    raw_src = np.asarray(pixel_points, dtype=np.float64)
    dst = np.asarray(world_points, dtype=np.float64)

    def objective(k1: float) -> float:
        return _mean_reprojection_error(
            _undistort_points(raw_src, k1, native_size),
            dst,
        )

    # 검증 참조(syn_prod.py)의 golden-section search. 탐색구간 자체가 최종 clamp라
    # 음수/과대 k1이 production state로 나갈 수 없다.
    a, b = _K1_MIN, _K1_MAX
    ratio = (np.sqrt(5.0) - 1.0) / 2.0
    c = b - ratio * (b - a)
    d = a + ratio * (b - a)
    while abs(b - a) > _GOLDEN_SECTION_TOLERANCE:
        if objective(c) < objective(d):
            b = d
        else:
            a = c
        c = b - ratio * (b - a)
        d = a + ratio * (b - a)

    fitted = float(np.clip((a + b) / 2.0, _K1_MIN, _K1_MAX))
    if not np.isfinite(fitted) or fitted <= _K1_GATE:
        return 0.0
    return fitted


def _compute_homography(
    pixel_points: list[list[float]],
    world_points: list[list[float]],
    native_size: list[float] | tuple[float, float] | None = None,
) -> HomographyResult:
    """다점 homography 계산.

    4점: exact fit (reprojection 0).
    5점+: least-squares — 모든 점이 H에 기여, outlier 제거 없음
    (`cv2.findHomography(src, dst, 0)`, RANSAC 아님).
    """
    raw_src = np.array(pixel_points, dtype=np.float64)
    dst = np.array(world_points, dtype=np.float64)

    n = len(pixel_points)
    k1 = _fit_k1(pixel_points, world_points, native_size)
    src = _undistort_points(raw_src, k1, native_size)
    H, _ = cv2.findHomography(src, dst, 0)

    if H is None:
        raise HTTPException(
            status_code=400,
            detail="homography 계산 실패 — 점 배치가 부적절합니다",
        )

    det = np.linalg.det(H)
    if abs(det) < 1e-10:
        raise HTTPException(
            status_code=400,
            detail="homography 행렬이 singular입니다 — 점 배치를 확인하세요",
        )

    inlier_mask = [1] * n

    H_inv = np.linalg.inv(H)
    reproj = cv2.perspectiveTransform(dst.reshape(-1, 1, 2), H_inv)
    errors = np.linalg.norm(reproj.reshape(-1, 2) - src, axis=1)

    return HomographyResult(
        H=H.tolist(),
        k1=k1,
        reprojection_errors=[round(float(e), 2) for e in errors],
        mean_reprojection_error=round(float(errors.mean()), 2),
        inlier_mask=inlier_mask,
    )


def pixel_to_world(
    homography: list[list[float]] | None,
    u: float,
    v: float,
    k1: float = 0.0,
    native_size: list[float] | tuple[float, float] | None = None,
) -> tuple[float, float] | None:
    """단일 픽셀 (u, v) 를 H 행렬로 월드 (X, Y) m 로 변환.

    k1+native_size가 있으면 검증된 단일 radial 보정을 H 적용 전에 수행한다.
    homography 가 None 이면 None 반환 (calibration 미설정).
    projective division 시 w 가 0 에 수렴하면 None (지평선 근처 등 신뢰 불가 영역).
    """
    if homography is None:
        return None
    H = np.asarray(homography, dtype=np.float64)
    corrected_u, corrected_v = _undistort_point(u, v, k1, native_size)
    src = np.array([corrected_u, corrected_v, 1.0], dtype=np.float64)
    dst = H @ src
    w = dst[2]
    if abs(w) < 1e-9:
        return None
    return float(dst[0] / w), float(dst[1] / w)
