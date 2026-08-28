import { describe, expect, it } from "vitest";
import type { Detection } from "../types/detection";
import {
  buildDetectionPairs,
  canApplyMeasurementSettings,
  filterDetectionsByClassConfidence,
  minimumClassConfidence,
  PERSON_CLASS,
} from "./detectionPairs";
import type { SelectedYoloClass } from "../types/detection";

function det(
  classId: number,
  name: string,
  x: number,
  conf = 0.9,
  model = "yolo26x.pt",
): Detection {
  return {
    class_id: classId,
    name,
    conf,
    xyxy: [x, 0, x + 10, 10],
    model,
  };
}

function selected(
  id: number,
  name: string,
  model: string,
  conf = 0.5,
): SelectedYoloClass {
  return { id, name, model, conf };
}

describe("buildDetectionPairs", () => {
  it("각 preset person마다 custom 객체의 최단거리 1개만 만든다", () => {
    const p1 = det(0, "person", 0);
    const p2 = det(0, "person", 100);
    const c1 = det(0, "forklift", 10, 0.9, "warehouse.pt");
    const c2 = det(0, "forklift", 80, 0.9, "warehouse.pt");
    const selection = [PERSON_CLASS, selected(0, "forklift", "warehouse.pt")];

    expect(
      buildDetectionPairs(
        [p1, c1, p2, c2],
        selection,
        (from, to) => Math.abs(from.xyxy[0] - to.xyxy[0]),
      ),
    ).toEqual([[p1, c1], [p2, c2]]);
  });

  it("2개 대 1개면 상대 bbox를 재사용해 최단거리 2개를 만든다", () => {
    const p1 = det(0, "person", 0);
    const p2 = det(0, "person", 100);
    const chair = det(0, "forklift", 40, 0.9, "warehouse.pt");

    expect(
      buildDetectionPairs(
        [p1, chair, p2],
        [PERSON_CLASS, selected(0, "forklift", "warehouse.pt")],
        (from, to) => Math.abs(from.xyxy[0] - to.xyxy[0]),
      ),
    ).toEqual([[p1, chair], [p2, chair]]);
  });

  it("person 1개와 상대 bbox 2개면 가장 가까운 거리 1개만 만든다", () => {
    const person = det(0, "person", 50);
    const nearChair = det(0, "forklift", 60, 0.9, "warehouse.pt");
    const farChair = det(0, "forklift", 150, 0.9, "warehouse.pt");

    expect(
      buildDetectionPairs(
        [farChair, person, nearChair],
        [PERSON_CLASS, selected(0, "forklift", "warehouse.pt")],
        (from, to) => Math.abs(from.xyxy[0] - to.xyxy[0]),
      ),
    ).toEqual([[person, nearChair]]);
  });

  it("같은 class_id라도 선택하지 않은 custom 모델의 detection은 후보에서 제외한다", () => {
    const person = det(0, "person", 0);
    const selectedForklift = det(0, "forklift", 40, 0.9, "warehouse.pt");
    const otherForklift = det(0, "forklift", 5, 0.9, "other.pt");

    expect(
      buildDetectionPairs(
        [person, otherForklift, selectedForklift],
        [PERSON_CLASS, selected(0, "forklift", "warehouse.pt")],
        (from, to) => Math.abs(from.xyxy[0] - to.xyxy[0]),
      ),
    ).toEqual([[person, selectedForklift]]);
  });

  it("world 좌표를 만들 수 없는 custom 후보는 최단거리 계산에서 건너뛴다", () => {
    const person = det(0, "person", 0);
    const invalid = det(0, "forklift", 10, 0.9, "warehouse.pt");
    const valid = det(0, "forklift", 30, 0.9, "warehouse.pt");

    expect(
      buildDetectionPairs(
        [person, invalid, valid],
        [PERSON_CLASS, selected(0, "forklift", "warehouse.pt")],
        (_from, to) => (to === invalid ? null : 30),
      ),
    ).toEqual([[person, valid]]);
  });

  it("모델 태그가 다르거나 person+custom 정확한 2개 선택이 아니면 거부한다", () => {
    const p1 = det(0, "person", 0);
    const custom = det(0, "forklift", 20, 0.9, "warehouse.pt");
    expect(buildDetectionPairs([p1, custom], [])).toEqual([]);
    expect(buildDetectionPairs([p1, custom], [PERSON_CLASS])).toEqual([]);
    expect(
      buildDetectionPairs(
        [p1, custom],
        [PERSON_CLASS, selected(0, "forklift", "other.pt")],
      ),
    ).toEqual([]);
  });
});

describe("filterDetectionsByClassConfidence", () => {
  it("선택한 클래스마다 서로 다른 confidence 임계값을 적용한다", () => {
    const personLow = det(0, "person", 0, 0.49);
    const personAtThreshold = det(0, "person", 20, 0.5);
    const carLow = det(0, "forklift", 40, 0.79, "warehouse.pt");
    const carHigh = det(0, "forklift", 60, 0.81, "warehouse.pt");
    const wrongModel = det(0, "forklift", 70, 0.99, "other.pt");
    const unselected = det(5, "bus", 80, 0.99);

    expect(
      filterDetectionsByClassConfidence(
        [personLow, personAtThreshold, carLow, carHigh, wrongModel, unselected],
        [
          { ...PERSON_CLASS, conf: 0.5 },
          selected(0, "forklift", "warehouse.pt", 0.8),
        ],
      ),
    ).toEqual([personAtThreshold, carHigh]);
  });

  it("백엔드 수집 임계값은 선택 클래스 confidence 중 최솟값을 사용한다", () => {
    expect(
      minimumClassConfidence([
        { ...PERSON_CLASS, conf: 0.7 },
        selected(0, "forklift", "warehouse.pt", 0.35),
      ]),
    ).toBe(0.35);
  });
});

describe("canApplyMeasurementSettings", () => {
  it("OFF는 클래스 선택 없이 적용할 수 있다", () => {
    expect(canApplyMeasurementSettings(false, 0, false, false)).toBe(true);
  });

  it("ON은 활성 기준점, custom 가중치, custom 클래스 1개가 모두 필요하다", () => {
    expect(canApplyMeasurementSettings(true, 0, true, true)).toBe(false);
    expect(canApplyMeasurementSettings(true, 1, false, true)).toBe(false);
    expect(canApplyMeasurementSettings(true, 1, true, false)).toBe(false);
    expect(canApplyMeasurementSettings(true, 1, true, true)).toBe(true);
  });
});
