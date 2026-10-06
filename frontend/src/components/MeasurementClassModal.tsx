import { useEffect, useState } from "react";
import type {
  LaneStatus,
  SelectedYoloClass,
  WeightsStatus,
  YoloClass,
} from "../types/detection";
import {
  ANCHOR_LANE,
  canApplyMeasurementSettings,
  DEFAULT_CLASS_CONFIDENCE,
  hasSameClassName,
  normalizeClassConfidence,
  TARGET_LANE,
} from "../utils/detectionPairs";
import MeasurementLaneCard from "./MeasurementLaneCard";
import Modal from "./Modal";

export type LaneClasses = Record<string, YoloClass[]>;

interface Props {
  open: boolean;
  cameraName: string;
  laneClasses: LaneClasses;
  initialEnabled: boolean;
  initialSelection: SelectedYoloClass[];
  canEnable: boolean;
  saving: boolean;
  weights: WeightsStatus | null;
  weightsBusy: boolean;
  weightsError: string;
  selectionResetToken: number;
  onClose: () => void;
  onConfirm: (enabled: boolean, classes: SelectedYoloClass[]) => void;
  onUploadWeights: (lane: string, file: File) => void;
  onResetWeights: (lane: string) => void;
}

const LANE_LABEL: Record<string, string> = {
  [ANCHOR_LANE]: "기준",
  [TARGET_LANE]: "상대",
};

// 매 렌더 새 배열이 만들어지면 아래 useEffect 의존성이 매번 바뀐다. 모듈 상수로 고정한다.
const NO_CLASSES: YoloClass[] = [];

/** 저장 선택 하나가 그 레인에 아직 유효한지 — id 와 이름이 모두 같아야 한다. */
function matchesLaneClass(
  item: SelectedYoloClass,
  lane: string,
  classes: readonly YoloClass[],
): boolean {
  return (
    item.model === lane
    && classes.some((candidate) => candidate.id === item.id && candidate.name === item.name)
  );
}

/**
 * 레인의 기본 선택 클래스.
 *
 * 기준 레인은 person 이 있으면 그것을 고른다(preset 이면 COCO id 0). person 이 없는
 * 업로드 가중치와 상대 레인은 기본 선택이 없다 — 사용자가 반드시 고른다.
 */
export function pickDefaultClass(
  lane: string,
  status: LaneStatus | null,
  classes: readonly YoloClass[],
): number | null {
  if (lane !== ANCHOR_LANE || status == null) return null;
  const person = classes.find((item) => item.name.trim().toLowerCase() === "person");
  return person ? person.id : null;
}

export default function MeasurementClassModal({
  open,
  cameraName,
  laneClasses,
  initialEnabled,
  initialSelection,
  canEnable,
  saving,
  weights,
  weightsBusy,
  weightsError,
  selectionResetToken,
  onClose,
  onConfirm,
  onUploadWeights,
  onResetWeights,
}: Props) {
  const [enabled, setEnabled] = useState(false);
  const [anchorId, setAnchorId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [anchorConfidence, setAnchorConfidence] = useState(DEFAULT_CLASS_CONFIDENCE);
  const [targetConfidence, setTargetConfidence] = useState(DEFAULT_CLASS_CONFIDENCE);

  const anchorStatus = weights?.lanes.anchor ?? null;
  const targetStatus = weights?.lanes.target ?? null;
  const anchorClasses = laneClasses[ANCHOR_LANE] ?? NO_CLASSES;
  const targetClasses = laneClasses[TARGET_LANE] ?? NO_CLASSES;
  const targetAvailable = targetStatus != null;

  useEffect(() => {
    if (!open) return;
    const storedAnchor = initialSelection.find(
      (item) => matchesLaneClass(item, ANCHOR_LANE, anchorClasses),
    );
    const storedTarget = initialSelection.find(
      (item) => matchesLaneClass(item, TARGET_LANE, targetClasses),
    );
    setEnabled(initialEnabled && targetAvailable);
    setAnchorId(
      storedAnchor ? storedAnchor.id : pickDefaultClass(ANCHOR_LANE, anchorStatus, anchorClasses),
    );
    setTargetId(
      storedTarget ? storedTarget.id : pickDefaultClass(TARGET_LANE, targetStatus, targetClasses),
    );
    setAnchorConfidence(normalizeClassConfidence(storedAnchor?.conf));
    setTargetConfidence(normalizeClassConfidence(storedTarget?.conf));
  }, [
    anchorClasses,
    anchorStatus,
    initialEnabled,
    initialSelection,
    open,
    selectionResetToken,
    targetAvailable,
    targetClasses,
    targetStatus,
  ]);

  const locked = saving || weightsBusy;
  const anchorSelected = anchorClasses.find((item) => item.id === anchorId) ?? null;
  const targetSelected = targetClasses.find((item) => item.id === targetId) ?? null;
  const sameClassName = hasSameClassName(anchorSelected, targetSelected);
  const selectedClasses: SelectedYoloClass[] = [
    ...(anchorSelected
      ? [{ ...anchorSelected, model: ANCHOR_LANE, conf: normalizeClassConfidence(anchorConfidence) }]
      : []),
    ...(targetSelected
      ? [{ ...targetSelected, model: TARGET_LANE, conf: normalizeClassConfidence(targetConfidence) }]
      : []),
  ];
  const canApply = canApplyMeasurementSettings(
    enabled,
    anchorSelected,
    targetSelected,
    canEnable,
    targetAvailable,
  );

  const alertIcon = (
    <svg
      className="ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 4.2 2.6 19.2a1.2 1.2 0 0 0 1 1.8h16.8a1.2 1.2 0 0 0 1-1.8z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17.6" r=".9" fill="currentColor" stroke="none" />
    </svg>
  );

  return (
    <Modal
      open={open}
      onClose={locked ? () => {} : onClose}
      title={`${cameraName} · 자동 측정 설정`}
      maxWidth={680}
    >
      <section className="measure-weights" aria-labelledby="measure-weights-title">
        <div className="measure-weights-head">
          <div>
            <strong id="measure-weights-title">추론 가중치</strong>
            <p>레인별 가중치 1개 · 클래스 1개</p>
          </div>
          <span className={`measure-weight-badge${targetAvailable ? " custom" : " missing"}`}>
            {targetAvailable ? "준비됨" : "상대 레인 가중치 필요"}
          </span>
        </div>
        <div className="measure-weight-stack">
          <MeasurementLaneCard
            key={`${ANCHOR_LANE}-${selectionResetToken}`}
            lane={ANCHOR_LANE}
            label={LANE_LABEL[ANCHOR_LANE]}
            status={anchorStatus}
            classes={anchorClasses}
            selectedId={anchorId}
            confidence={anchorConfidence}
            locked={locked}
            onSelect={(classId) => {
              setAnchorId(classId);
              setAnchorConfidence(DEFAULT_CLASS_CONFIDENCE);
            }}
            onConfidence={setAnchorConfidence}
            onUpload={(file) => onUploadWeights(ANCHOR_LANE, file)}
            onReset={() => onResetWeights(ANCHOR_LANE)}
          />
          <MeasurementLaneCard
            key={`${TARGET_LANE}-${selectionResetToken}`}
            lane={TARGET_LANE}
            label={LANE_LABEL[TARGET_LANE]}
            status={targetStatus}
            classes={targetClasses}
            selectedId={targetId}
            confidence={targetConfidence}
            locked={locked}
            onSelect={(classId) => {
              setTargetId(classId);
              setTargetConfidence(DEFAULT_CLASS_CONFIDENCE);
            }}
            onConfidence={setTargetConfidence}
            onUpload={(file) => onUploadWeights(TARGET_LANE, file)}
            onReset={() => onResetWeights(TARGET_LANE)}
          />
        </div>
        {weightsBusy && (
          <p className="measure-weight-progress" role="status">가중치 검증·적용 중</p>
        )}
        {weightsError && <p className="measure-weight-error" role="alert">{weightsError}</p>}
      </section>

      <div className="measure-state-control">
        <div>
          <strong>자동 거리측정</strong>
          <span className={`measure-state-label ${enabled ? "on" : "off"}`}>
            {enabled ? "ON" : "OFF"}
          </span>
        </div>
        <div className="measure-state-buttons" role="group" aria-label="자동 거리측정 상태">
          <button
            type="button"
            className={`btn sm${!enabled ? " selected" : ""}`}
            disabled={locked}
            aria-pressed={!enabled}
            onClick={() => setEnabled(false)}
          >
            OFF
          </button>
          <button
            type="button"
            className={`btn sm${enabled ? " selected on" : ""}`}
            disabled={locked || !canEnable || !targetAvailable}
            aria-pressed={enabled}
            onClick={() => setEnabled(true)}
          >
            ON
          </button>
        </div>
      </div>
      {!canEnable && (
        <p className="measure-state-warning">{alertIcon}ON 조건 — 기준점 저장 · 측정 활성화</p>
      )}
      {!targetAvailable && (
        <p className="measure-state-warning">{alertIcon}ON 조건 — 상대 레인 가중치 업로드</p>
      )}
      {enabled && !(anchorSelected && targetSelected) && (
        <p className="measure-state-warning">{alertIcon}적용 조건 — 레인별 클래스 1개 선택</p>
      )}
      {sameClassName && (
        <p className="measure-state-warning">{alertIcon}적용 조건 — 기준·상대 클래스는 서로 달라야 함</p>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" disabled={locked} onClick={onClose}>취소</button>
        <button
          type="button"
          className="btn primary"
          disabled={locked || !canApply}
          onClick={() => canApply && onConfirm(enabled, selectedClasses)}
        >
          {saving ? "저장 중…" : "적용"}
        </button>
      </div>
    </Modal>
  );
}
