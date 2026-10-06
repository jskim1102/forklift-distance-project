import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { LaneStatus, YoloClass } from "../types/detection";
import { canApplyMeasurementSettings } from "../utils/detectionPairs";
import MeasurementClassModal, { pickDefaultClass } from "./MeasurementClassModal";

const view = vi.hoisted(() => ({ states: [] as unknown[], index: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: () => {
    const index = view.index++;
    return [view.states[index], (value: unknown) => { view.states[index] = value; }];
  },
  useEffect: () => {},
}));

beforeEach(() => {
  view.states = [true, 0, 7, 0.5, 0.5];
  view.index = 0;
});

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
        canApplyMeasurementSettings(
          enabled,
          hasAnchor ? { id: 0, name: "person" } : null,
          hasTarget ? { id: 0, name: "forklift" } : null,
          canEnable,
          targetAvailable,
        ),
      ).toBe(expected);
    },
  );
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

function renderModal(onConfirm: Parameters<typeof MeasurementClassModal>[0]["onConfirm"]) {
  view.index = 0;
  const tree = MeasurementClassModal({
    open: true, cameraName: "test", initialEnabled: true, initialSelection: [],
    laneClasses: { anchor: COCO, target: [{ id: 7, name: " PERSON " }, { id: 0, name: "forklift" }] },
    canEnable: true, saving: false,
    weights: { lanes: { anchor: PRESET_ANCHOR, target: UPLOADED_TARGET } },
    weightsBusy: false, weightsError: "", selectionResetToken: 0,
    onClose: vi.fn(), onConfirm, onUploadWeights: vi.fn(), onResetWeights: vi.fn(),
  });
  const nodes = elements(tree);
  return {
    nodes,
    apply: nodes.find((node) => node.type === "button" && node.props.children === "적용")!,
    warning: nodes.find((node) => Array.isArray(node.props.children)
      && node.props.children.includes("적용 조건 — 기준·상대 클래스는 서로 달라야 함")),
  };
}

describe("동일 클래스명 적용 차단", () => {
  it.each([true, false])("자동측정 %s에서도 같은 이름은 적용과 콜백을 막고 조건을 안내한다", (enabled) => {
    view.states[0] = enabled;
    const onConfirm = vi.fn();
    const { apply, warning } = renderModal(onConfirm);

    expect(apply.props.disabled).toBe(true);
    expect(warning?.props.className).toBe("measure-state-warning");
    (apply.props.onClick as () => void)();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("다른 상대 클래스로 바꾸면 안내가 사라지고 같은 id여도 정상 적용한다", () => {
    const onConfirm = vi.fn();
    const before = renderModal(onConfirm);
    const targetCard = before.nodes.find((node) => node.props.lane === "target")!;
    (targetCard.props.onSelect as (id: number) => void)(0);
    const { apply, warning } = renderModal(onConfirm);

    expect(warning).toBeUndefined();
    expect(apply.props.disabled).toBe(false);
    (apply.props.onClick as () => void)();
    expect(onConfirm).toHaveBeenCalledWith(true, [
      { id: 0, name: "person", model: "anchor", conf: 0.5 },
      { id: 0, name: "forklift", model: "target", conf: 0.5 },
    ]);
  });
});
