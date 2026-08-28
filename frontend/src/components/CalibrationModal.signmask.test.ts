import { describe, expect, it } from "vitest";

import {
  searchBestSignMask,
  restoreEnabled,
  type CalibrationState,
  type CalibrationUpdate,
} from "./CalibrationModal";

// Finding #1 regression: searchBestSignMask PUTs every sign-mask candidate (onSave is a
// real PUT that commits each candidate). It must guarantee the DB ends up holding the
// BEST (lowest mean_reprojection_error) orientation — not whichever candidate happened
// to be tried last. When no candidate hits the err<1 early break, the last-tried
// candidate is worse than the best, so a final re-PUT of the best is required.

// 4 base points → 2^(4-2)=4 sign-mask candidates. Points 0,1 have y=0 (untouched by mask);
// points 2,3 have positive y, so a flipped candidate is detectable by a negative y.
const baseWp: [number, number][] = [
  [0, 0],
  [2, 0],
  [1, 1.5],
  [3, 2.5],
];
const pixelPoints: number[][] = [
  [0, 0],
  [10, 0],
  [5, 5],
  [8, 3],
];

const IDENTITY_H = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

// Reconstruct which sign-mask a saved world_points array corresponds to, purely from the
// y-sign of the two toggled points. bit0 = point2 flipped, bit1 = point3 flipped.
function maskOf(wp: number[][]): number {
  const bit0 = wp[2][1] < 0 ? 1 : 0;
  const bit1 = wp[3][1] < 0 ? 1 : 0;
  return bit0 | (bit1 << 1);
}

// Build a recording onSave whose returned mean_reprojection_error is keyed by candidate mask.
function makeOnSave(errByMask: Record<number, number>) {
  const calls: number[][][] = [];
  const payloads: CalibrationUpdate[] = [];
  const onSave = async (payload: CalibrationUpdate): Promise<CalibrationState | null> => {
    calls.push(payload.world_points);
    payloads.push(payload);
    const err = errByMask[maskOf(payload.world_points)];
    const state: CalibrationState = {
      enabled: payload.enabled,
      pixel_points: payload.pixel_points,
      world_points: payload.world_points,
      homography: IDENTITY_H,
      k1: 0,
      native_size: payload.native_size,
      reprojection_errors: null,
      mean_reprojection_error: err,
      inlier_mask: null,
    };
    return state;
  };
  return { onSave, calls, payloads };
}

describe("searchBestSignMask (finding #1 — persist the best, not the last-tried)", () => {
  it("re-PUTs the best candidate last when the last-tried candidate is worse", async () => {
    // mask1 is best (err 2). No candidate is <1 so the loop never early-breaks; mask3 (err 3)
    // is tried last. Without the final re-save the DB would end holding mask3.
    const { onSave, calls } = makeOnSave({ 0: 5, 1: 2, 2: 8, 3: 3 });

    const { best } = await searchBestSignMask(baseWp, pixelPoints, true, onSave);

    expect(best).not.toBeNull();
    expect(best!.mean_reprojection_error).toBe(2); // best is the lowest-error candidate
    // The DB's final state = the LAST PUT. It must carry the best (mask1) orientation.
    const lastPut = calls[calls.length - 1];
    expect(maskOf(lastPut)).toBe(1);
  });

  it("does not emit a redundant re-save when the early-break candidate is already the best", async () => {
    // mask1 has err<1 → loop breaks right after saving it, so it is already the last PUT.
    const { onSave, calls } = makeOnSave({ 0: 5, 1: 0.5, 2: 8, 3: 3 });

    const { best } = await searchBestSignMask(baseWp, pixelPoints, true, onSave);

    expect(best!.mean_reprojection_error).toBe(0.5);
    // masks 0 then 1 tried; mask1 breaks and is already last → no extra PUT (2 calls total).
    expect(calls.length).toBe(2);
    expect(maskOf(calls[calls.length - 1])).toBe(1);
  });
});

describe("searchBestSignMask (finding #4 — persists the user's enabled choice)", () => {
  it("propagates enabled=false into every PUT (not a hardcoded true)", async () => {
    const { onSave, payloads } = makeOnSave({ 0: 5, 1: 2, 2: 8, 3: 3 });

    await searchBestSignMask(baseWp, pixelPoints, false, onSave);

    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.every((p) => p.enabled === false)).toBe(true);
  });

  it("propagates enabled=true when the toggle is on", async () => {
    const { onSave, payloads } = makeOnSave({ 0: 5, 1: 2, 2: 8, 3: 3 });

    await searchBestSignMask(baseWp, pixelPoints, true, onSave);

    expect(payloads.every((p) => p.enabled === true)).toBe(true);
  });
});

describe("searchBestSignMask (single-k1 native-size contract)", () => {
  it("propagates the snapshot native size into every candidate and final best PUT", async () => {
    const { onSave, payloads } = makeOnSave({ 0: 5, 1: 2, 2: 8, 3: 3 });

    await searchBestSignMask(baseWp, pixelPoints, true, onSave, [1920, 1080]);

    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.every((p) => p.native_size?.[0] === 1920 && p.native_size?.[1] === 1080)).toBe(true);
  });
});

// Regression (fix.ckpt3): fresh cameras return a backend DEFAULT calibration state object
// (homography: null, enabled: false) — truthy. Restoring enabled off that object turned a
// brand-new calibration off, so the saved PUT committed enabled:false and the grid gate
// (finding #4) correctly blocked measurement → user saw "저장 안 됨 + 측정 비활성".
describe("restoreEnabled (open-restore enabled initial value)", () => {
  it("keeps fresh cameras enabled (default state: homography null, enabled false → true)", () => {
    const fresh: CalibrationState = {
      enabled: false,
      pixel_points: null,
      world_points: null,
      homography: null,
      k1: 0,
      native_size: null,
      reprojection_errors: null,
      mean_reprojection_error: null,
      inlier_mask: null,
    };
    expect(restoreEnabled(fresh)).toBe(true);
  });

  it("restores a saved calibration's enabled=false (homography present → honor stored value)", () => {
    const saved: CalibrationState = {
      enabled: false,
      pixel_points: [
        [0, 0],
        [10, 0],
        [5, 5],
        [8, 3],
      ],
      world_points: [
        [0, 0],
        [2, 0],
        [1, 1.5],
        [3, 2.5],
      ],
      homography: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      k1: 0,
      native_size: [1920, 1080],
      reprojection_errors: null,
      mean_reprojection_error: 0.4,
      inlier_mask: null,
    };
    expect(restoreEnabled(saved)).toBe(false);
  });

  it("restores a saved calibration's enabled=true", () => {
    const saved: CalibrationState = {
      enabled: true,
      pixel_points: [[0, 0]],
      world_points: [[0, 0]],
      homography: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      k1: 0,
      native_size: [1920, 1080],
      reprojection_errors: null,
      mean_reprojection_error: 0.4,
      inlier_mask: null,
    };
    expect(restoreEnabled(saved)).toBe(true);
  });

  it("defaults to enabled when there is no initial state at all", () => {
    expect(restoreEnabled(null)).toBe(true);
    expect(restoreEnabled(undefined)).toBe(true);
  });
});
