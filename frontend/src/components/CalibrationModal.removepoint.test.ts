import { describe, expect, it } from "vitest";

import { remapDistancesAfterRemoval } from "./CalibrationModal";

// codex-review #1 (fix.ckpt5) regression: removePoint reindexes `points` (filter shifts every
// point after the deleted index down by 1) but the old code copied `distances` under the SAME
// pair-keys — so deleting a non-last point silently reattached old measured distances to keys
// that now describe DIFFERENT physical point pairs → wrong world coords → wrong homography.
//
// remapDistancesAfterRemoval must remap by POINT IDENTITY: a surviving point at old index j>idx
// becomes j-1; any distance whose endpoint is the removed idx is dropped; only keys still in
// getRequiredPairs(newN) survive. Value === old-key sentinel so each assertion reads which
// physical pair the new key carries. Distance pairs are always [0,1], [0,i], [1,i] (i≥2).
const N5 = {
  "0-1": "0-1",
  "0-2": "0-2",
  "1-2": "1-2",
  "0-3": "0-3",
  "1-3": "1-3",
  "0-4": "0-4",
  "1-4": "1-4",
};

describe("remapDistancesAfterRemoval (fix.ckpt5 — remap distances by point identity)", () => {
  it("middle (non-anchor) delete remaps every surviving distance to the correct physical pair", () => {
    // n=5, delete idx=2 → new point 2=old 3, new point 3=old 4. Anchors 0,1 unchanged.
    // Every required pair for newN=4 is recoverable → complete, zero re-entry needed.
    expect(remapDistancesAfterRemoval(N5, 2, 4)).toEqual({
      "0-1": "0-1", // anchors untouched
      "0-2": "0-3", // new pt2 = old pt3
      "1-2": "1-3",
      "0-3": "0-4", // new pt3 = old pt4
      "1-3": "1-4",
    });
  });

  it("anchor delete idx=0 blanks the now-unmeasurable [1,x] pairs (forces re-entry, no silent wrong data)", () => {
    // Deleting anchor 0 shifts the triangulation basis: new basis = old pts 1,2. The new
    // required [1,x] pairs (d(old2, old_{x+1})) were never measured, so they must fall out.
    expect(remapDistancesAfterRemoval(N5, 0, 4)).toEqual({
      "0-1": "1-2", // new anchor pair = d(old1, old2)
      "0-2": "1-3",
      "0-3": "1-4",
      // 1-2, 1-3 absent → save-gate marks them missing → user re-enters
    });
  });

  it("anchor delete idx=1 likewise keeps only the recoverable [0,x] pairs", () => {
    expect(remapDistancesAfterRemoval(N5, 1, 4)).toEqual({
      "0-1": "0-2",
      "0-2": "0-3",
      "0-3": "0-4",
    });
  });

  it("last delete (idx=n-1) leaves every surviving distance unchanged", () => {
    // Deleting the highest index shifts nothing; only its own [0,4]/[1,4] pairs drop.
    expect(remapDistancesAfterRemoval(N5, 4, 4)).toEqual({
      "0-1": "0-1",
      "0-2": "0-2",
      "1-2": "1-2",
      "0-3": "0-3",
      "1-3": "1-3",
    });
  });

  it("drops distances that reference the removed point", () => {
    // Every key touching idx must be gone regardless of position.
    const out = remapDistancesAfterRemoval(N5, 2, 4);
    expect(Object.values(out)).not.toContain("0-2"); // old d(0,2) referenced removed pt2
    expect(Object.values(out)).not.toContain("1-2");
  });
});
