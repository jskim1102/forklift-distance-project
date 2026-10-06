import { describe, expect, it } from "vitest";
import type { Detection, SelectedYoloClass } from "../types/detection";
import {
  ANCHOR_LANE,
  buildDetectionPairs,
  canApplyMeasurementSettings,
  filterDetectionsByClassConfidence,
  minimumClassConfidence,
  reconcileMeasurements,
  restoreSelection,
  TARGET_LANE,
} from "./detectionPairs";

function det(
  classId: number,
  name: string,
  x: number,
  conf = 0.9,
  model = ANCHOR_LANE,
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

const ANCHOR_PERSON = selected(0, "person", ANCHOR_LANE);
const TARGET_FORKLIFT = selected(0, "forklift", TARGET_LANE);

describe("buildDetectionPairs", () => {
  it("기준 레인 검출마다 상대 레인의 최단거리 1개만 만든다", () => {
    const a1 = det(0, "person", 0);
    const a2 = det(0, "person", 100);
    const t1 = det(0, "forklift", 10, 0.9, TARGET_LANE);
    const t2 = det(0, "forklift", 80, 0.9, TARGET_LANE);

    expect(
      buildDetectionPairs(
        [a1, t1, a2, t2],
        [ANCHOR_PERSON, TARGET_FORKLIFT],
        (from, to) => Math.abs(from.xyxy[0] - to.xyxy[0]),
      ),
    ).toEqual([[a1, t1], [a2, t2]]);
  });

  it("2개 대 1개면 상대 bbox를 재사용해 최단거리 2개를 만든다", () => {
    const a1 = det(0, "person", 0);
    const a2 = det(0, "person", 100);
    const shared = det(0, "forklift", 40, 0.9, TARGET_LANE);

    expect(
      buildDetectionPairs(
        [a1, shared, a2],
        [ANCHOR_PERSON, TARGET_FORKLIFT],
        (from, to) => Math.abs(from.xyxy[0] - to.xyxy[0]),
      ),
    ).toEqual([[a1, shared], [a2, shared]]);
  });

  it("기준 1개와 상대 2개면 가장 가까운 거리 1개만 만든다", () => {
    const anchor = det(0, "person", 50);
    const near = det(0, "forklift", 60, 0.9, TARGET_LANE);
    const far = det(0, "forklift", 150, 0.9, TARGET_LANE);

    expect(
      buildDetectionPairs(
        [far, anchor, near],
        [ANCHOR_PERSON, TARGET_FORKLIFT],
        (from, to) => Math.abs(from.xyxy[0] - to.xyxy[0]),
      ),
    ).toEqual([[anchor, near]]);
  });

  it("두 레인의 원본 파일명이 같아도 lane id 로 분리한다", () => {
    // 두 레인 모두 best.pt 를 올린 상황 — detection 의 model 값은 레인 id 다.
    const anchorBox = det(0, "person", 0, 0.9, ANCHOR_LANE);
    const targetBox = det(0, "forklift", 30, 0.9, TARGET_LANE);

    expect(
      buildDetectionPairs(
        [anchorBox, targetBox],
        [ANCHOR_PERSON, TARGET_FORKLIFT],
        (from, to) => Math.abs(from.xyxy[0] - to.xyxy[0]),
      ),
    ).toEqual([[anchorBox, targetBox]]);
  });

  it("같은 class_id라도 선택하지 않은 클래스의 검출은 후보에서 제외한다", () => {
    const anchor = det(0, "person", 0);
    const chosen = det(0, "forklift", 40, 0.9, TARGET_LANE);
    const other = det(3, "pallet", 5, 0.9, TARGET_LANE);

    expect(
      buildDetectionPairs(
        [anchor, other, chosen],
        [ANCHOR_PERSON, TARGET_FORKLIFT],
        (from, to) => Math.abs(from.xyxy[0] - to.xyxy[0]),
      ),
    ).toEqual([[anchor, chosen]]);
  });

  it("world 좌표를 만들 수 없는 상대 후보는 최단거리 계산에서 건너뛴다", () => {
    const anchor = det(0, "person", 0);
    const invalid = det(0, "forklift", 10, 0.9, TARGET_LANE);
    const valid = det(0, "forklift", 30, 0.9, TARGET_LANE);

    expect(
      buildDetectionPairs(
        [anchor, invalid, valid],
        [ANCHOR_PERSON, TARGET_FORKLIFT],
        (_from, to) => (to === invalid ? null : 30),
      ),
    ).toEqual([[anchor, valid]]);
  });

  it("레인별 1개씩 정확히 2개 선택이 아니면 거부한다", () => {
    const anchor = det(0, "person", 0);
    const target = det(0, "forklift", 20, 0.9, TARGET_LANE);

    expect(buildDetectionPairs([anchor, target], [])).toEqual([]);
    expect(buildDetectionPairs([anchor, target], [ANCHOR_PERSON])).toEqual([]);
    expect(
      buildDetectionPairs(
        [anchor, target],
        [ANCHOR_PERSON, selected(1, "pallet", ANCHOR_LANE)],
      ),
    ).toEqual([]);
    expect(
      buildDetectionPairs(
        [anchor, target],
        [ANCHOR_PERSON, selected(0, "forklift", "warehouse.pt")],
      ),
    ).toEqual([]);
  });
});

describe("filterDetectionsByClassConfidence", () => {
  it("선택한 클래스마다 서로 다른 confidence 임계값을 적용한다", () => {
    const anchorLow = det(0, "person", 0, 0.49);
    const anchorAtThreshold = det(0, "person", 20, 0.5);
    const targetLow = det(0, "forklift", 40, 0.79, TARGET_LANE);
    const targetHigh = det(0, "forklift", 60, 0.81, TARGET_LANE);
    const unselected = det(5, "bus", 80, 0.99);

    expect(
      filterDetectionsByClassConfidence(
        [anchorLow, anchorAtThreshold, targetLow, targetHigh, unselected],
        [
          selected(0, "person", ANCHOR_LANE, 0.5),
          selected(0, "forklift", TARGET_LANE, 0.8),
        ],
      ),
    ).toEqual([anchorAtThreshold, targetHigh]);
  });

  it("백엔드 수집 임계값은 선택 클래스 confidence 중 최솟값을 사용한다", () => {
    expect(
      minimumClassConfidence([
        selected(0, "person", ANCHOR_LANE, 0.7),
        selected(0, "forklift", TARGET_LANE, 0.35),
      ]),
    ).toBe(0.35);
  });
});

describe("canApplyMeasurementSettings", () => {
  it("OFF는 클래스 선택 없이 적용할 수 있다", () => {
    expect(canApplyMeasurementSettings(false, null, null, false, false)).toBe(true);
  });

  it("ON은 기준점·상대 레인 활성·레인별 클래스 1개가 모두 필요하다", () => {
    expect(canApplyMeasurementSettings(true, null, TARGET_FORKLIFT, true, true)).toBe(false);
    expect(canApplyMeasurementSettings(true, ANCHOR_PERSON, null, true, true)).toBe(false);
    expect(canApplyMeasurementSettings(true, ANCHOR_PERSON, TARGET_FORKLIFT, false, true)).toBe(false);
    expect(canApplyMeasurementSettings(true, ANCHOR_PERSON, TARGET_FORKLIFT, true, false)).toBe(false);
    expect(canApplyMeasurementSettings(true, ANCHOR_PERSON, TARGET_FORKLIFT, true, true)).toBe(true);
  });

  it.each(["person", "PERSON", "  Person\t"])("같은 클래스명 %s는 id가 달라도 적용을 막는다", (name) => {
    const target = selected(7, name, TARGET_LANE);
    expect(canApplyMeasurementSettings(true, ANCHOR_PERSON, target, true, true)).toBe(false);
    expect(canApplyMeasurementSettings(false, ANCHOR_PERSON, target, true, true)).toBe(false);
  });

  it("공백·대소문자는 양쪽 이름 모두에 적용하고 다른 이름은 허용한다", () => {
    const anchor = selected(0, "  PERSON\t", ANCHOR_LANE);
    expect(canApplyMeasurementSettings(true, anchor, selected(7, "person", TARGET_LANE), true, true)).toBe(false);
    expect(canApplyMeasurementSettings(true, anchor, TARGET_FORKLIFT, true, true)).toBe(true);
  });
});

describe("restoreSelection", () => {
  const catalog = {
    [ANCHOR_LANE]: [{ id: 0, name: "person" }, { id: 2, name: "car" }],
    [TARGET_LANE]: [{ id: 0, name: "forklift" }],
  };

  it("레인·id·이름이 모두 맞으면 복원한다", () => {
    const stored = [ANCHOR_PERSON, TARGET_FORKLIFT];

    expect(restoreSelection(stored, catalog)).toEqual({
      classes: stored,
      dropped: false,
    });
  });

  it("레인 id 가 아닌 model 은 폐기한다", () => {
    const stored = [selected(0, "person", "yolo26x.pt"), TARGET_FORKLIFT];

    expect(restoreSelection(stored, catalog)).toEqual({
      classes: [TARGET_FORKLIFT],
      dropped: true,
    });
  });

  it("비활성 레인의 선택은 폐기한다", () => {
    const stored = [ANCHOR_PERSON, TARGET_FORKLIFT];

    expect(restoreSelection(stored, { [ANCHOR_LANE]: catalog[ANCHOR_LANE], [TARGET_LANE]: null })).toEqual({
      classes: [ANCHOR_PERSON],
      dropped: true,
    });
  });

  it("클래스 목록에 없는 id 는 폐기한다", () => {
    const stored = [selected(7, "pallet", ANCHOR_LANE), TARGET_FORKLIFT];

    expect(restoreSelection(stored, catalog)).toEqual({
      classes: [TARGET_FORKLIFT],
      dropped: true,
    });
  });

  it("id 는 같아도 이름이 바뀌었으면 폐기한다", () => {
    const stored = [ANCHOR_PERSON, selected(0, "pallet", TARGET_LANE)];

    expect(restoreSelection(stored, catalog)).toEqual({
      classes: [ANCHOR_PERSON],
      dropped: true,
    });
  });

  it.each(["person", "PERSON", " person\t"])("각 레인에 유효해도 같은 이름 %s의 상대 선택은 폐기한다", (name) => {
    const target = selected(7, name, TARGET_LANE);
    const sameNameCatalog = { ...catalog, [TARGET_LANE]: [{ id: 7, name }] };
    for (const stored of [[ANCHOR_PERSON, target], [target, ANCHOR_PERSON]]) {
      expect(restoreSelection(stored, sameNameCatalog)).toEqual({ classes: [ANCHOR_PERSON], dropped: true });
      expect(stored).toHaveLength(2);
    }
  });
});

describe("reconcileMeasurements", () => {
  const catalog = {
    [ANCHOR_LANE]: [{ id: 0, name: "person" }],
    [TARGET_LANE]: [{ id: 0, name: "forklift" }],
  };

  it("무효화가 없으면 disabled 가 비고 enabled 가 유지된다", () => {
    const measurements = {
      "ipcam-a": { enabled: true, classes: [ANCHOR_PERSON, TARGET_FORKLIFT] },
      "ipcam-b": { enabled: false, classes: [ANCHOR_PERSON, TARGET_FORKLIFT] },
    };

    expect(reconcileMeasurements(measurements, catalog)).toEqual({
      next: measurements,
      disabled: [],
    });
  });

  it("무효화된 카메라 키를 disabled 로 모으고 enabled 를 내린다", () => {
    // 상대 레인 가중치가 교체돼 forklift 가 사라진 상황.
    const replaced = {
      [ANCHOR_LANE]: catalog[ANCHOR_LANE],
      [TARGET_LANE]: [{ id: 0, name: "pallet" }],
    };
    const measurements = {
      "ipcam-a": { enabled: true, classes: [ANCHOR_PERSON, TARGET_FORKLIFT] },
      "ipcam-b": { enabled: true, classes: [ANCHOR_PERSON, TARGET_FORKLIFT] },
    };

    expect(reconcileMeasurements(measurements, replaced)).toEqual({
      next: {
        "ipcam-a": { enabled: false, classes: [ANCHOR_PERSON] },
        "ipcam-b": { enabled: false, classes: [ANCHOR_PERSON] },
      },
      disabled: ["ipcam-a", "ipcam-b"],
    });
  });

  it("이미 꺼져 있던 카메라는 disabled 에 넣지 않는다", () => {
    const measurements = {
      "ipcam-a": { enabled: false, classes: [ANCHOR_PERSON, TARGET_FORKLIFT] },
    };

    expect(reconcileMeasurements(measurements, { [ANCHOR_LANE]: catalog[ANCHOR_LANE], [TARGET_LANE]: null })).toEqual({
      next: { "ipcam-a": { enabled: false, classes: [ANCHOR_PERSON] } },
      disabled: [],
    });
  });

  it("어긋난 레인의 선택만 비우고 반대쪽은 유지한다", () => {
    const measurements = {
      "ipcam-a": { enabled: true, classes: [ANCHOR_PERSON, TARGET_FORKLIFT] },
    };

    const result = reconcileMeasurements(measurements, {
      [ANCHOR_LANE]: null,
      [TARGET_LANE]: catalog[TARGET_LANE],
    });

    expect(result.next["ipcam-a"].classes).toEqual([TARGET_FORKLIFT]);
    expect(result.disabled).toEqual(["ipcam-a"]);
  });

  it("빈 목록은 빈 결과를 돌려준다", () => {
    expect(reconcileMeasurements({}, catalog)).toEqual({ next: {}, disabled: [] });
  });

  it("같은 클래스명 저장값은 자동측정을 끄고 켜져 있던 카메라만 backend OFF 대상으로 보낸다", () => {
    const target = selected(7, " PERSON ", TARGET_LANE);
    const result = reconcileMeasurements({
      "ipcam-on": { enabled: true, classes: [ANCHOR_PERSON, target] },
      "ipcam-off": { enabled: false, classes: [ANCHOR_PERSON, target] },
    }, { ...catalog, [TARGET_LANE]: [{ id: 7, name: " PERSON " }] });

    expect(result).toEqual({
      next: {
        "ipcam-on": { enabled: false, classes: [ANCHOR_PERSON] },
        "ipcam-off": { enabled: false, classes: [ANCHOR_PERSON] },
      },
      disabled: ["ipcam-on"],
    });
  });
});
