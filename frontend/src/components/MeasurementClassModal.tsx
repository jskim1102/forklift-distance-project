import { useEffect, useMemo, useState } from "react";
import type { SelectedYoloClass, WeightsStatus, YoloClass } from "../types/detection";
import {
  canApplyMeasurementSettings,
  DEFAULT_CLASS_CONFIDENCE,
  MAX_CLASS_CONFIDENCE,
  MIN_CLASS_CONFIDENCE,
  normalizeClassConfidence,
  PERSON_CLASS,
} from "../utils/detectionPairs";
import Modal from "./Modal";

interface Props {
  open: boolean;
  cameraName: string;
  classes: YoloClass[];
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
  onUploadWeights: (file: File) => void;
  onResetWeights: () => void;
}

export function filterSelectableCustomClasses(classes: readonly YoloClass[]): YoloClass[] {
  const fixedPersonName = PERSON_CLASS.name.trim().toLowerCase();
  return classes.filter((item) => item.name.trim().toLowerCase() !== fixedPersonName);
}

export default function MeasurementClassModal({
  open,
  cameraName,
  classes,
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
  const [query, setQuery] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [selectedCustomId, setSelectedCustomId] = useState<number | null>(null);
  const [personConfidence, setPersonConfidence] = useState(DEFAULT_CLASS_CONFIDENCE);
  const [customConfidence, setCustomConfidence] = useState(DEFAULT_CLASS_CONFIDENCE);
  const [weightFile, setWeightFile] = useState<File | null>(null);

  const customName = weights?.custom?.name ?? null;
  const customWeightsAvailable = customName != null;
  const customClasses = useMemo(() => filterSelectableCustomClasses(classes), [classes]);

  useEffect(() => {
    if (!open) return;
    const initialPerson = initialSelection.find(
      (item) => item.model === PERSON_CLASS.model && item.id === PERSON_CLASS.id,
    );
    const initialCustom = initialSelection.find(
      (item) => item.model === customName && customClasses.some((candidate) => candidate.id === item.id),
    );
    setQuery("");
    setEnabled(initialEnabled && customWeightsAvailable);
    setSelectedCustomId(
      initialCustom
        ? initialCustom.id
        : null,
    );
    setPersonConfidence(normalizeClassConfidence(initialPerson?.conf));
    setCustomConfidence(normalizeClassConfidence(initialCustom?.conf));
    setWeightFile(null);
  }, [
    customClasses,
    customName,
    customWeightsAvailable,
    initialEnabled,
    initialSelection,
    open,
    selectionResetToken,
  ]);

  const locked = saving || weightsBusy;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? customClasses.filter((item) => item.name.toLowerCase().includes(needle))
      : customClasses;
  }, [customClasses, query]);
  const selectedCustom = customClasses.find((item) => item.id === selectedCustomId) ?? null;
  const selectedClasses: SelectedYoloClass[] = selectedCustom && customName
    ? [
        { ...PERSON_CLASS, conf: normalizeClassConfidence(personConfidence) },
        {
          ...selectedCustom,
          model: customName,
          conf: normalizeClassConfidence(customConfidence),
        },
      ]
    : [{ ...PERSON_CLASS, conf: normalizeClassConfidence(personConfidence) }];
  const canApply = canApplyMeasurementSettings(
    enabled,
    selectedCustom ? 1 : 0,
    canEnable,
    customWeightsAvailable,
  );

  const confirm = () => {
    if (canApply) onConfirm(enabled, selectedClasses);
  };

  return (
    <Modal
      open={open}
      onClose={locked ? () => {} : onClose}
      title={`${cameraName} · 자동 측정 설정`}
      maxWidth={620}
    >
      <section className="measure-weights" aria-labelledby="measure-weights-title">
        <div className="measure-weights-head">
          <div>
            <strong id="measure-weights-title">추론 가중치</strong>
            <p>기본 person 모델과 커스텀 모델을 동시에 사용합니다.</p>
          </div>
          <span className={`measure-weight-badge${customWeightsAvailable ? " custom" : " missing"}`}>
            <svg
              className="ico measure-weight-alert"
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
            {customWeightsAvailable ? "DUAL" : "CUSTOM 필요"}
          </span>
        </div>
        <div className="measure-weight-stack">
          <div className="measure-weight-current">
            <span>PERSON · 고정</span>
            <strong>{weights?.preset_name ?? "불러오는 중…"}</strong>
            <small>person</small>
          </div>
          <div className="measure-weight-current">
            <span>CUSTOM</span>
            <strong>{weights?.custom?.name ?? "업로드되지 않음"}</strong>
            {weights?.custom ? (
              <small>
                클래스 {weights.custom.class_count}개 · {weights.custom.size_mb.toFixed(2)} MB
              </small>
            ) : <small>자동 측정 전에 업로드하세요</small>}
          </div>
        </div>
        <div className="measure-weight-upload">
          <input
            key={selectionResetToken}
            type="file"
            accept=".pt"
            disabled={locked}
            aria-label="YOLO custom .pt 가중치 파일"
            onChange={(event) => setWeightFile(event.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            className="btn sm"
            disabled={locked || weightFile == null}
            onClick={() => weightFile && onUploadWeights(weightFile)}
          >
            {weightsBusy ? "업로드 중…" : "업로드"}
          </button>
        </div>
        {customWeightsAvailable && (
          <button
            type="button"
            className="btn sm measure-weight-reset"
            disabled={locked}
            onClick={onResetWeights}
          >
            커스텀 가중치 제거
          </button>
        )}
        {weightsBusy && (
          <p className="measure-weight-progress" role="status">
            가중치를 검증하고 적용하는 중입니다…
          </p>
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
            disabled={locked || !canEnable || !customWeightsAvailable}
            aria-pressed={enabled}
            onClick={() => setEnabled(true)}
          >
            ON
          </button>
        </div>
      </div>
      {!canEnable && (
        <p className="measure-state-warning">
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
          ON으로 설정하려면 기준점을 저장하고 측정을 활성화하세요.
        </p>
      )}
      {!customWeightsAvailable && (
        <p className="measure-state-warning">
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
          자동 측정을 켜려면 custom .pt 가중치를 업로드하세요.
        </p>
      )}

      <p className="measure-class-help">
        yolo26x의 person은 고정입니다. custom 가중치에서 거리 상대 클래스 1개를 선택하세요.
      </p>
      <div className="measure-person-fixed" aria-label="고정 기준 클래스">
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
          <circle cx="12" cy="7" r="3" />
          <path d="M5.5 20v-1a6.5 6.5 0 0 1 13 0v1" />
        </svg>
        <span>기준 클래스</span>
        <strong>person</strong>
        <small>{weights?.preset_name ?? "yolo26x.pt"}</small>
      </div>
      <div className="field">
        <label htmlFor="measure-class-search">Custom 클래스 검색</label>
        <input
          id="measure-class-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="forklift, pallet ..."
          disabled={!customWeightsAvailable}
          autoFocus
        />
      </div>
      <div className="measure-class-summary" role="status">
        <span>Custom 선택 {selectedCustom ? 1 : 0}/1</span>
        <span className="measure-class-chip">person · 고정</span>
        {selectedCustom && <span className="measure-class-chip">{selectedCustom.name}</span>}
      </div>

      <div className="measure-confidence-list" aria-label="클래스별 confidence 설정">
        <label className="measure-confidence-row">
          <span className="measure-confidence-name">person</span>
          <input
            type="range"
            min={MIN_CLASS_CONFIDENCE}
            max={MAX_CLASS_CONFIDENCE}
            step="0.05"
            value={personConfidence}
            disabled={locked}
            onChange={(event) => setPersonConfidence(normalizeClassConfidence(Number(event.target.value)))}
            aria-label="person confidence"
          />
          <output>{personConfidence.toFixed(2)}</output>
        </label>
        {selectedCustom && (
          <label className="measure-confidence-row">
            <span className="measure-confidence-name">{selectedCustom.name}</span>
            <input
              type="range"
              min={MIN_CLASS_CONFIDENCE}
              max={MAX_CLASS_CONFIDENCE}
              step="0.05"
              value={customConfidence}
              disabled={locked}
              onChange={(event) => setCustomConfidence(normalizeClassConfidence(Number(event.target.value)))}
              aria-label={`${selectedCustom.name} confidence`}
            />
            <output>{customConfidence.toFixed(2)}</output>
          </label>
        )}
      </div>

      <div className="measure-class-grid" aria-label="Custom YOLO 클래스 목록">
        {visible.map((item) => {
          const checked = selectedCustomId === item.id;
          return (
            <label className={`measure-class-option${checked ? " selected" : ""}`} key={item.id}>
              <input
                type="radio"
                name="measure-custom-class"
                checked={checked}
                disabled={locked || !customWeightsAvailable}
                onChange={() => {
                  setSelectedCustomId(item.id);
                  setCustomConfidence(DEFAULT_CLASS_CONFIDENCE);
                }}
              />
              <span>{item.name}</span>
            </label>
          );
        })}
        {visible.length === 0 && (
          <p className="measure-class-empty">
            {customWeightsAvailable ? "일치하는 클래스가 없습니다." : "Custom 가중치를 먼저 업로드하세요."}
          </p>
        )}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" disabled={locked} onClick={onClose}>취소</button>
        <button
          type="button"
          className="btn primary"
          disabled={locked || !canApply}
          onClick={confirm}
        >
          {saving ? "저장 중…" : "적용"}
        </button>
      </div>
    </Modal>
  );
}
