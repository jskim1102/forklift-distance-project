import { useMemo, useState } from "react";
import type { LaneStatus, YoloClass } from "../types/detection";
import {
  MAX_CLASS_CONFIDENCE,
  MIN_CLASS_CONFIDENCE,
  normalizeClassConfidence,
} from "../utils/detectionPairs";

interface Props {
  lane: string;
  /** 레인 역할 라벨 — "기준" / "상대" */
  label: string;
  status: LaneStatus | null;
  classes: YoloClass[];
  selectedId: number | null;
  confidence: number;
  locked: boolean;
  onSelect: (classId: number) => void;
  onConfidence: (value: number) => void;
  onUpload: (file: File) => void;
  onReset: () => void;
}

/** 두 레인이 같은 코드를 쓰게 해서 비대칭이 다시 자라지 못하게 한다. */
export default function MeasurementLaneCard({
  lane,
  label,
  status,
  classes,
  selectedId,
  confidence,
  locked,
  onSelect,
  onConfidence,
  onUpload,
  onReset,
}: Props) {
  const [query, setQuery] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const uploaded = status?.source === "upload";
  const available = status != null;
  const searchId = `measure-${lane}-search`;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? classes.filter((item) => item.name.toLowerCase().includes(needle)) : classes;
  }, [classes, query]);
  const selected = classes.find((item) => item.id === selectedId) ?? null;

  return (
    <section className="measure-lane-card" aria-label={`${label} 레인`}>
      <div className="measure-lane-head">
        <strong>{label} 레인</strong>
        <span className={`measure-weight-badge${uploaded ? " custom" : available ? "" : " missing"}`}>
          {uploaded ? "업로드" : available ? "기본" : "미업로드"}
        </span>
        <span className="measure-lane-name">{status?.name ?? "—"}</span>
        <small>
          {status
            ? `클래스 ${status.class_count}개${
                status.size_mb != null ? ` · ${status.size_mb.toFixed(2)} MB` : ""
              }`
            : "가중치 업로드 필요"}
        </small>
      </div>

      <div className="measure-weight-upload">
        <input
          type="file"
          accept=".pt"
          disabled={locked}
          aria-label={`${label} 레인 .pt 가중치 파일`}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          className="btn sm"
          disabled={locked || file == null}
          onClick={() => file && onUpload(file)}
        >
          업로드
        </button>
        {uploaded && (
          <button type="button" className="btn sm" disabled={locked} onClick={onReset}>
            업로드 가중치 제거
          </button>
        )}
      </div>

      <div className="field">
        <label htmlFor={searchId}>{label} 클래스 검색</label>
        <input
          id={searchId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="forklift, pallet ..."
          disabled={locked || !available}
        />
      </div>

      <div className="measure-class-summary" role="status">
        <span>{label} 선택 {selected ? 1 : 0}/1</span>
        {selected && <span className="measure-class-chip">{selected.name}</span>}
      </div>

      <div className="measure-class-grid" aria-label={`${label} 레인 클래스 목록`}>
        {visible.map((item) => {
          const checked = selectedId === item.id;
          return (
            <label className={`measure-class-option${checked ? " selected" : ""}`} key={item.id}>
              <input
                type="radio"
                name={`measure-${lane}-class`}
                checked={checked}
                disabled={locked || !available}
                onChange={() => onSelect(item.id)}
              />
              <span>{item.name}</span>
            </label>
          );
        })}
        {visible.length === 0 && (
          <p className="measure-class-empty">
            {available ? "일치 클래스 없음" : "가중치 업로드 필요"}
          </p>
        )}
      </div>

      <label className="measure-confidence-row">
        <span className="measure-confidence-name">confidence</span>
        <input
          type="range"
          min={MIN_CLASS_CONFIDENCE}
          max={MAX_CLASS_CONFIDENCE}
          step="0.05"
          value={confidence}
          disabled={locked || !available}
          onChange={(event) => onConfidence(normalizeClassConfidence(Number(event.target.value)))}
          aria-label={`${label} 레인 confidence`}
        />
        <output>{confidence.toFixed(2)}</output>
      </label>
    </section>
  );
}
