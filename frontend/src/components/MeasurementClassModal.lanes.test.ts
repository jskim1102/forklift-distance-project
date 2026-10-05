import { describe, expect, it } from "vitest";
import type { LaneStatus, YoloClass } from "../types/detection";
import { canApplyMeasurementSettings } from "../utils/detectionPairs";
import { pickDefaultClass } from "./MeasurementClassModal";

const COCO: YoloClass[] = [
  { id: 0, name: "person" },
  { id: 1, name: "bicycle" },
  { id: 2, name: "car" },
];

const PRESET_ANCHOR: LaneStatus = {
  lane: "anchor",
  source: "preset",
  name: "yolo26x.pt",
  uploaded_at: null,
  size_mb: null,
  class_count: 80,
};

const UPLOADED_ANCHOR: LaneStatus = {
  lane: "anchor",
  source: "upload",
  name: "site.pt",
  uploaded_at: "2026-09-08T00:00:00Z",
  size_mb: 12.34,
  class_count: 3,
};

const UPLOADED_TARGET: LaneStatus = {
  ...UPLOADED_ANCHOR,
  lane: "target",
  name: "warehouse.pt",
};

describe("pickDefaultClass", () => {
  it("preset 기준 레인은 COCO person 을 기본 선택한다", () => {
    expect(pickDefaultClass("anchor", PRESET_ANCHOR, COCO)).toBe(0);
  });

  it("업로드 기준 레인에 person 이 있으면 그 id 를 기본 선택한다", () => {
    expect(
      pickDefaultClass("anchor", UPLOADED_ANCHOR, [
        { id: 3, name: "forklift" },
        { id: 7, name: "person" },
      ]),
    ).toBe(7);
  });

  it("업로드 기준 레인에 person 이 없으면 기본 선택이 없다", () => {
    expect(
      pickDefaultClass("anchor", UPLOADED_ANCHOR, [
        { id: 0, name: "forklift" },
        { id: 1, name: "pallet" },
      ]),
    ).toBeNull();
  });

  it("상대 레인은 person 이 있어도 기본 선택이 없다", () => {
    expect(pickDefaultClass("target", UPLOADED_TARGET, COCO)).toBeNull();
  });

  it("비활성 레인은 기본 선택이 없다", () => {
    expect(pickDefaultClass("anchor", null, COCO)).toBeNull();
    expect(pickDefaultClass("target", null, COCO)).toBeNull();
  });
});

describe("적용 버튼 활성 조합", () => {
  const rows: Array<[string, boolean, boolean, boolean, boolean, boolean, boolean]> = [
    // 설명, enabled, hasAnchor, hasTarget, canEnable, targetAvailable, 기대
    ["OFF 는 선택 없이도 적용", false, false, false, false, false, true],
    ["ON + 모든 조건 충족", true, true, true, true, true, true],
    ["ON 인데 기준 선택 없음", true, false, true, true, true, false],
    ["ON 인데 상대 선택 없음", true, true, false, true, true, false],
    ["ON 인데 기준점 미활성", true, true, true, false, true, false],
    ["ON 인데 상대 레인 비활성", true, true, true, true, false, false],
  ];

  it.each(rows)(
    "%s",
    (_label, enabled, hasAnchor, hasTarget, canEnable, targetAvailable, expected) => {
      expect(
        canApplyMeasurementSettings(enabled, hasAnchor, hasTarget, canEnable, targetAvailable),
      ).toBe(expected);
    },
  );
});
