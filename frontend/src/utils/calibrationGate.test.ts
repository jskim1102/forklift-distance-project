import { describe, expect, it } from "vitest";

import { measurableHomography } from "./calibrationGate";

const H = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

// Finding #4: the grid must enforce state.enabled — a saved homography alone is not enough.
describe("measurableHomography (enabled = 측정 표시 on/off gate)", () => {
  it("returns the homography when enabled", () => {
    expect(measurableHomography(true, H)).toBe(H);
  });

  it("returns null when disabled even though a homography exists", () => {
    expect(measurableHomography(false, H)).toBeNull();
  });

  it("returns null when there is no homography regardless of enabled", () => {
    expect(measurableHomography(true, null)).toBeNull();
    expect(measurableHomography(false, null)).toBeNull();
  });
});
