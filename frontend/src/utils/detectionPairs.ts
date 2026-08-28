import type { Detection, SelectedYoloClass } from "../types/detection";

export type DetectionPair = readonly [Detection, Detection];
export type DetectionPairDistance = (from: Detection, to: Detection) => number | null;

export const DEFAULT_CLASS_CONFIDENCE = 0.5;
export const MIN_CLASS_CONFIDENCE = 0.05;
export const MAX_CLASS_CONFIDENCE = 0.95;
export const PERSON_CLASS_ID = 0;
export const PERSON_MODEL = "yolo26x.pt";
export const PERSON_CLASS: SelectedYoloClass = {
  id: PERSON_CLASS_ID,
  name: "person",
  model: PERSON_MODEL,
  conf: DEFAULT_CLASS_CONFIDENCE,
};

export function modelClassKey(model: string, classId: number): string {
  return `${model}\u0000${classId}`;
}

export function canApplyMeasurementSettings(
  enabled: boolean,
  selectedCustomClassCount: number,
  canEnable: boolean,
  customWeightsAvailable: boolean,
): boolean {
  return !enabled
    || (canEnable && customWeightsAvailable && selectedCustomClassCount === 1);
}

export function normalizeClassConfidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CLASS_CONFIDENCE;
  return Math.min(MAX_CLASS_CONFIDENCE, Math.max(MIN_CLASS_CONFIDENCE, parsed));
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
 * 고정 yolo26x person을 anchor로 삼아 각 person의 가장 가까운 custom 객체 1개를
 * 연결한다. custom bbox 재사용은 허용한다. class_id는 모델마다 겹칠 수 있으므로
 * 모든 비교는 model+class_id 복합키로 수행한다.
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
  const personSelection = selectedClasses.find(
    (item) => item.model === PERSON_MODEL && item.id === PERSON_CLASS_ID,
  );
  const customSelection = selectedClasses.find((item) => item.model !== PERSON_MODEL);
  if (!personSelection || !customSelection) return [];

  const personKey = modelClassKey(personSelection.model, personSelection.id);
  const customKey = modelClassKey(customSelection.model, customSelection.id);
  const anchors = detections.filter(
    (det) => modelClassKey(det.model, det.class_id) === personKey,
  );
  const candidates = detections.filter(
    (det) => modelClassKey(det.model, det.class_id) === customKey,
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
