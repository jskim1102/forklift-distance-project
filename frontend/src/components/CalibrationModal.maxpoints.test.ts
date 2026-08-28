import { describe, expect, it } from "vitest";

import { MAX_POINTS } from "./CalibrationModal";

describe("CalibrationModal point limit", () => {
  it("allows up to 20 calibration points", () => {
    expect(MAX_POINTS).toBe(20);
  });
});
