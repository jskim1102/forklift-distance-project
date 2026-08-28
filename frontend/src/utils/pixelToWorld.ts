// JS port of prime backend pixel_to_world (.sources/prime/backend/app/inference/distance.py
// L12-30). Applies a 3x3 homography to a single pixel and returns its world (X, Y) in metres.
// numpy-equivalent: dst = H @ [u, v, 1]; w = dst[2]; null if |w| < 1e-9; else [dst0/w, dst1/w].

export type Homography = number[][];

export function pixelToWorld(
  H: Homography | null,
  u: number,
  v: number,
  k1 = 0,
  nativeSize: readonly [number, number] | null = null,
): [number, number] | null {
  if (H === null) return null; // calibration 미설정

  // backend _undistort_point 와 byte-identical 규약. native size가 없는 구클라이언트
  // calibration은 k1 값이 있어도 legacy 좌표를 그대로 적용한다.
  let correctedU = u;
  let correctedV = v;
  if (k1 !== 0 && nativeSize && nativeSize[0] > 0 && nativeSize[1] > 0) {
    const cx = nativeSize[0] / 2;
    const cy = nativeSize[1] / 2;
    const s = nativeSize[0] / 2;
    const nx = (u - cx) / s;
    const ny = (v - cy) / s;
    const r2 = nx * nx + ny * ny;
    const distortion = 1 + k1 * r2;
    correctedU = nx * distortion * s + cx;
    correctedV = ny * distortion * s + cy;
  }

  // dst = H · [u, v, 1]
  const x = H[0][0] * correctedU + H[0][1] * correctedV + H[0][2];
  const y = H[1][0] * correctedU + H[1][1] * correctedV + H[1][2];
  const w = H[2][0] * correctedU + H[2][1] * correctedV + H[2][2];

  // projective division 시 w 가 0 에 수렴하면 신뢰 불가(지평선 근처 등) → null.
  if (Math.abs(w) < 1e-9) return null;

  return [x / w, y / w];
}
