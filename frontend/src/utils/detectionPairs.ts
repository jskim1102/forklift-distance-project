import type {
  AutoMeasurement,
  Detection,
  SelectedYoloClass,
  YoloClass,
} from "../types/detection";

export type DetectionPair = readonly [Detection, Detection];
export type DetectionPairDistance = (from: Detection, to: Detection) => number | null;

export const DEFAULT_CLASS_CONFIDENCE = 0.5;
export const MIN_CLASS_CONFIDENCE = 0.05;
export const MAX_CLASS_CONFIDENCE = 0.95;

/** 거리쌍 기준 레인. 업로드가 없으면 preset(yolo26x.pt)으로 떨어진다. */
export const ANCHOR_LANE = "anchor";
/** 거리쌍 상대 레인. 업로드가 없으면 preset(yolo26x.pt)으로 떨어진다. */
export const TARGET_LANE = "target";
export const LANE_IDS: readonly string[] = [ANCHOR_LANE, TARGET_LANE];

/** 레인 id → 그 레인의 현재 클래스 목록. 비활성 레인은 null·undefined. */
export type LaneClassCatalog = Partial<Record<string, readonly YoloClass[] | null>>;

export interface RestoredSelection {
  classes: SelectedYoloClass[];
  dropped: boolean;
}

export function isLaneId(model: string): boolean {
  return LANE_IDS.includes(model);
}

export function modelClassKey(model: string, classId: number): string {
  return `${model}\u0000${classId}`;
}

export function hasSameClassName(
  anchor: YoloClass | null | undefined,
  target: YoloClass | null | undefined,
): boolean {
  return anchor != null && target != null
    && anchor.name.trim().toLowerCase() === target.name.trim().toLowerCase();
}

export function canApplyMeasurementSettings(
  enabled: boolean,
  anchor: YoloClass | null,
  target: YoloClass | null,
  canEnable: boolean,
  targetAvailable: boolean,
): boolean {
  return !hasSameClassName(anchor, target)
    && (!enabled || (canEnable && targetAvailable && anchor != null && target != null));
}

export function normalizeClassConfidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CLASS_CONFIDENCE;
  return Math.min(MAX_CLASS_CONFIDENCE, Math.max(MIN_CLASS_CONFIDENCE, parsed));
}

/**
 * 저장된 선택을 현재 레인 상태에 비춰 복원한다.
 *
 * (1) model 이 레인 id, (2) 그 레인이 활성,
 * (3) 그 레인의 클래스 목록에 같은 id 가 있고 이름도 같을 때 복원한다. 이름까지 보는 이유는
 * 같은 id 가 다른 클래스로 바뀐 모델 교체를 걸러야 하기 때문이다.
 * 두 레인의 클래스명이 같으면 상대 선택을 해제한다 — 같은 검출끼리 짝지어지는 것을 막는다.
 */
export function restoreSelection(
  stored: readonly SelectedYoloClass[],
  laneClasses: LaneClassCatalog,
): RestoredSelection {
  const classes = stored.filter((item) => {
    if (!isLaneId(item.model)) return false;
    const available = laneClasses[item.model];
    if (!Array.isArray(available)) return false;
    return available.some(
      (candidate) => candidate.id === item.id && candidate.name === item.name,
    );
  });
  const anchor = classes.find((item) => item.model === ANCHOR_LANE);
  const target = classes.find((item) => item.model === TARGET_LANE);
  if (hasSameClassName(anchor, target)) {
    return { classes: classes.filter((item) => item.model !== TARGET_LANE), dropped: true };
  }
  return { classes, dropped: classes.length !== stored.length };
}

export interface ReconciledMeasurements {
  next: Record<string, AutoMeasurement>;
  disabled: string[];
}

/**
 * 카메라별 저장 선택을 현재 레인 클래스 목록에 비춰 다시 판정한다.
 *
 * 부수효과 없는 순수 함수다 — 어긋난 레인의 선택을 비운 결과(next)와, 그 때문에
 * enabled 를 내려야 하는 카메라 키(disabled)를 함께 돌려준다. 호출부가 disabled 로
 * 백엔드 per-source 상태까지 맞춘다. 이 계산을 setState 업데이터 안에 두면 업데이터가
 * 동기 실행되지 않아 부수효과가 통째로 죽는다 — 그래서 밖으로 뺐다.
 */
export function reconcileMeasurements(
  measurements: Readonly<Record<string, AutoMeasurement>>,
  laneClasses: LaneClassCatalog,
): ReconciledMeasurements {
  const next: Record<string, AutoMeasurement> = {};
  const disabled: string[] = [];
  for (const [streamKey, measurement] of Object.entries(measurements)) {
    const restored = restoreSelection(measurement.classes, laneClasses);
    if (restored.dropped && measurement.enabled) disabled.push(streamKey);
    next[streamKey] = {
      enabled: measurement.enabled && !restored.dropped,
      classes: restored.classes,
    };
  }
  return { next, disabled };
}

/** 선택 클래스마다 지정된 confidence를 독립적으로 적용한다. */
export function filterDetectionsByClassConfidence(
  detections: readonly Detection[],
  selectedClasses: readonly SelectedYoloClass[],
): Detection[] {
  const confidenceByModelClass = new Map(
    selectedClasses.map((item) => [
      modelClassKey(item.model, item.id),
      normalizeClassConfidence(item.conf),
    ]),
  );
  return detections.filter((det) => {
    const threshold = confidenceByModelClass.get(modelClassKey(det.model, det.class_id));
    return threshold != null && det.conf >= threshold;
  });
}

/** 백엔드는 단일 threshold만 받으므로 선택값 중 최솟값으로 필요한 bbox를 모두 수신한다. */
export function minimumClassConfidence(selectedClasses: readonly SelectedYoloClass[]): number {
  return selectedClasses.length > 0
    ? Math.min(...selectedClasses.map((item) => normalizeClassConfidence(item.conf)))
    : DEFAULT_CLASS_CONFIDENCE;
}

/**
 * 자동 거리측정용 bbox 쌍을 만든다.
 *
 * 기준 레인(anchor) 검출 하나마다 가장 가까운 상대 레인(target) 검출 1개를 잇는다.
 * 상대 bbox 재사용은 허용한다. class_id는 레인마다 겹칠 수 있으므로 모든 비교는
 * lane+class_id 복합키로 수행한다 — 두 레인의 원본 파일명이 같아도 분리된다.
 */
export function buildDetectionPairs(
  detections: readonly Detection[],
  selectedClasses: readonly SelectedYoloClass[],
  distanceBetween: DetectionPairDistance = (from, to) => {
    const fromX = (from.xyxy[0] + from.xyxy[2]) / 2;
    const fromY = from.xyxy[3];
    const toX = (to.xyxy[0] + to.xyxy[2]) / 2;
    const toY = to.xyxy[3];
    return Math.hypot(toX - fromX, toY - fromY);
  },
): DetectionPair[] {
  if (selectedClasses.length !== 2) return [];
  const anchorSelection = selectedClasses.find((item) => item.model === ANCHOR_LANE);
  const targetSelection = selectedClasses.find((item) => item.model === TARGET_LANE);
  if (!anchorSelection || !targetSelection) return [];

  const anchorKey = modelClassKey(anchorSelection.model, anchorSelection.id);
  const targetKey = modelClassKey(targetSelection.model, targetSelection.id);
  const anchors = detections.filter(
    (det) => modelClassKey(det.model, det.class_id) === anchorKey,
  );
  const candidates = detections.filter(
    (det) => modelClassKey(det.model, det.class_id) === targetKey,
  );
  if (anchors.length === 0 || candidates.length === 0) return [];

  return anchors.flatMap((anchor): DetectionPair[] => {
    let nearest: Detection | null = null;
    let shortest = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const distance = distanceBetween(anchor, candidate);
      if (distance == null || !Number.isFinite(distance) || distance >= shortest) continue;
      shortest = distance;
      nearest = candidate;
    }
    return nearest ? [[anchor, nearest]] : [];
  });
}
