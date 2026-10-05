import { useState, useEffect, useCallback, useRef } from "react";
import { apiBase } from "../hooks/useApi";
import type {
  AutoMeasurement,
  LaneStatus,
  SelectedYoloClass,
  WeightsStatus,
  YoloClass,
} from "../types/detection";
import type { LaneClassCatalog } from "../utils/detectionPairs";
import {
  ANCHOR_LANE,
  isLaneId,
  minimumClassConfidence,
  modelClassKey,
  normalizeClassConfidence,
  reconcileMeasurements,
  TARGET_LANE,
} from "../utils/detectionPairs";
import CameraFormModal from "../components/CameraFormModal";
import CameraGrid from "../components/CameraGrid";
import MeasurementClassModal from "../components/MeasurementClassModal";
import type { LaneClasses } from "../components/MeasurementClassModal";

export interface Cam {
  id: number;
  name: string;
  rtsp_url: string;
  stream_key: string;
  created_at: string;
}

interface Stat {
  active: boolean;
  readers: number;
}

const MAX_IPCAMS_FALLBACK = 16; // spec F4 — /api/config 로딩 전 기본값. 실제 cap 은 백엔드 env.
// v2 — 모델 식별자가 파일명에서 레인 id 로 바뀌어 v1 데이터는 살릴 수 없다. 키를 올려 조용히 폐기한다.
export const MEASURE_STORAGE_KEY = "forklift-distance:auto-measure:v2";
const LEGACY_MEASURE_STORAGE_KEYS = ["forklift-distance:auto-measure:v1"];
const EMPTY_CLASSES: SelectedYoloClass[] = [];
const EMPTY_LANE_CLASSES: LaneClasses = { [ANCHOR_LANE]: [], [TARGET_LANE]: [] };

interface MeasurementStorage {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
}

export function loadStoredMeasurements(
  storage?: MeasurementStorage,
): Record<string, AutoMeasurement> {
  const store = storage ?? window.localStorage;
  try {
    for (const legacy of LEGACY_MEASURE_STORAGE_KEYS) store.removeItem(legacy);
    const parsed = JSON.parse(store.getItem(MEASURE_STORAGE_KEY) ?? "{}") as Record<
      string,
      Partial<AutoMeasurement>
    >;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([streamKey, value]) => {
        const classes = Array.isArray(value.classes)
          ? value.classes.flatMap((item) =>
              typeof item?.id === "number"
                && typeof item?.name === "string"
                && typeof item?.model === "string"
                && isLaneId(item.model)
                ? [{
                    id: item.id,
                    name: item.name,
                    model: item.model,
                    conf: normalizeClassConfidence(item.conf),
                  }]
                : [],
            ).filter((item, index, all) => (
              all.findIndex((candidate) => (
                modelClassKey(candidate.model, candidate.id) === modelClassKey(item.model, item.id)
              )) === index
            )).slice(0, 2)
          : [];
        const hasAnchor = classes.some((item) => item.model === ANCHOR_LANE);
        const hasTarget = classes.some((item) => item.model === TARGET_LANE);
        if (classes.length !== 2 || !hasAnchor || !hasTarget) return [];
        return [[streamKey, { enabled: value.enabled === true, classes }]];
      }),
    );
  } catch {
    return {};
  }
}

interface Props {
  // calibration 버튼 → App 이 풀페이지 CalibrationPage 로 전환.
  onCalibrate: (cam: Cam) => void;
}

async function loadLaneClasses(lane: string, status: LaneStatus | null): Promise<YoloClass[]> {
  if (status == null) return [];
  const response = await fetch(`${apiBase()}/api/inference/lanes/${lane}/classes`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error("레인 클래스 목록을 불러오지 못했습니다.");
  return response.json() as Promise<YoloClass[]>;
}

async function loadAllLaneClasses(status: WeightsStatus): Promise<LaneClasses> {
  const [anchor, target] = await Promise.all([
    loadLaneClasses(ANCHOR_LANE, status.lanes.anchor),
    loadLaneClasses(TARGET_LANE, status.lanes.target),
  ]);
  return { [ANCHOR_LANE]: anchor, [TARGET_LANE]: target };
}

export default function CamerasPage({ onCalibrate }: Props) {
  const [cams, setCams] = useState<Cam[]>([]);
  const [stats, setStats] = useState<Record<string, Stat>>({});
  // 실측 FPS — 그리드의 WhepPlayer 가 WebRTC getStats 로 올려주는 카메라별 디코딩 프레임레이트.
  const [fps, setFps] = useState<Record<string, number>>({});
  // 등록 cap — 백엔드 /api/config(MAX_IPCAMS env)에서 받음. 프론트 하드코딩 제거(P2-1).
  const [maxIpcams, setMaxIpcams] = useState(MAX_IPCAMS_FALLBACK);
  const [formOpen, setFormOpen] = useState(false);
  const [editCam, setEditCam] = useState<Cam | null>(null);
  const [error, setError] = useState("");
  const [autoMeasurements, setAutoMeasurements] = useState<Record<string, AutoMeasurement>>(
    loadStoredMeasurements,
  );
  const measurementsRef = useRef(autoMeasurements);
  const [measureTarget, setMeasureTarget] = useState<Cam | null>(null);
  const [measureCanEnable, setMeasureCanEnable] = useState(false);
  const [laneClasses, setLaneClasses] = useState<LaneClasses>(EMPTY_LANE_CLASSES);
  const [weights, setWeights] = useState<WeightsStatus | null>(null);
  const [weightsBusy, setWeightsBusy] = useState(false);
  const [weightsError, setWeightsError] = useState("");
  const [selectionResetToken, setSelectionResetToken] = useState(0);
  const [measureBusyKey, setMeasureBusyKey] = useState<string | null>(null);
  const [measureSaving, setMeasureSaving] = useState(false);

  const fetchCams = useCallback(async () => {
    const resp = await fetch(`${apiBase()}/api/ipcams`);
    if (!resp.ok) return;
    setCams(await resp.json());
  }, []);

  useEffect(() => {
    fetchCams();
  }, [fetchCams]);

  useEffect(() => {
    measurementsRef.current = autoMeasurements;
    window.localStorage.setItem(MEASURE_STORAGE_KEY, JSON.stringify(autoMeasurements));
  }, [autoMeasurements]);

  // 등록 cap 을 백엔드에서 1회 로딩 (없으면 fallback 유지).
  useEffect(() => {
    fetch(`${apiBase()}/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg?.max_ipcams) setMaxIpcams(cfg.max_ipcams);
      })
      .catch(() => {});
  }, []);

  // stats 1초 polling — 등록 카메라별 {active, readers} (mediamtx path 상태).
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const entries = await Promise.all(
        cams.map(async (c) => {
          try {
            const resp = await fetch(`${apiBase()}/api/ipcams/${c.stream_key}/stats`);
            if (!resp.ok) return [c.stream_key, { active: false, readers: 0 }] as const;
            return [c.stream_key, (await resp.json()) as Stat] as const;
          } catch {
            return [c.stream_key, { active: false, readers: 0 }] as const;
          }
        })
      );
      if (!cancelled) setStats(Object.fromEntries(entries));
    }
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cams]);

  const online = cams.filter((c) => stats[c.stream_key]?.active).length;
  const atCap = cams.length >= maxIpcams;

  const handleFps = useCallback((key: string, f: number) => {
    setFps((prev) => ({ ...prev, [key]: f }));
  }, []);

  // onSave 계약: 성공이면 null, 실패면 에러메시지(모달이 표시·열린 채 유지). POST 가
  // register-time ffprobe 로 수 초 걸릴 수 있어, 호출측(모달)이 await 하며 로딩상태를 보인다.
  async function handleSave(name: string, rtspUrl: string): Promise<string | null> {
    if (editCam) {
      const resp = await fetch(`${apiBase()}/api/ipcams/${editCam.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, rtsp_url: rtspUrl }),
      });
      if (!resp.ok) return "카메라 수정에 실패했습니다.";
    } else {
      const resp = await fetch(`${apiBase()}/api/ipcams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, rtsp_url: rtspUrl }),
      });
      if (resp.status === 409) {
        const body = await resp.json().catch(() => ({}));
        return body.detail ?? `최대 ${maxIpcams}대까지 등록할 수 있습니다`;
      }
      if (!resp.ok) return "카메라 등록에 실패했습니다.";
    }
    await fetchCams();
    return null;
  }

  async function deleteCam(cam: Cam) {
    if (!window.confirm(`${cam.name} 삭제?`)) return;
    const resp = await fetch(`${apiBase()}/api/ipcams/${cam.id}`, { method: "DELETE" });
    if (!resp.ok) {
      setError("카메라 삭제에 실패했습니다.");
      return;
    }
    setAutoMeasurements((current) => {
      const next = { ...current };
      delete next[cam.stream_key];
      return next;
    });
    await fetchCams();
  }

  /**
   * 저장된 선택을 현재 레인 상태로 다시 검증한다.
   *
   * 어긋난 레인의 선택만 비우고, 그 카메라의 enabled 는 내린다. 프론트만 끄면 백엔드
   * per-source 는 켜진 채 남으므로 PUT {enabled:false} 로 함께 맞춘다. 판정은 순수
   * 함수가 하고 여기서는 상태 반영과 전송만 한다 — setState 업데이터는 동기 실행이
   * 보장되지 않아 그 안에서 모은 목록은 호출 직후 비어 있다.
   */
  const syncMeasurementsWithLanes = useCallback(async (catalog: LaneClassCatalog) => {
    const { next, disabled } = reconcileMeasurements(measurementsRef.current, catalog);
    measurementsRef.current = next;
    setAutoMeasurements(next);
    setSelectionResetToken((current) => current + 1);
    await Promise.all(
      disabled.map((streamKey) =>
        fetch(`${apiBase()}/api/ipcams/${streamKey}/inference`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        }).catch(() => undefined),
      ),
    );
  }, []);

  // 재접속 직후에도 모델 교체를 감지한다. 모달을 열어야만 검증되면 저장된
  // 클래스 id가 다른 객체를 가리키는 동안 자동 측정이 계속 표시될 수 있다.
  useEffect(() => {
    let cancelled = false;
    async function restoreMeasurements() {
      const response = await fetch(`${apiBase()}/api/inference/weights`);
      if (!response.ok) throw new Error("활성 가중치 정보를 불러오지 못했습니다.");
      const nextWeights = await response.json() as WeightsStatus;
      const nextClasses = await loadAllLaneClasses(nextWeights);
      if (cancelled) return;
      setWeights(nextWeights);
      setLaneClasses(nextClasses);
      await syncMeasurementsWithLanes(nextClasses);
    }
    restoreMeasurements().catch((reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : "저장된 측정 설정을 확인하지 못했습니다.");
      }
    });
    return () => { cancelled = true; };
  }, [syncMeasurementsWithLanes]);

  async function openAutoMeasurementSettings(cam: Cam) {
    setError("");
    setWeightsError("");
    setMeasureBusyKey(cam.stream_key);
    try {
      const [calibrationResp, weightsResp] = await Promise.all([
        fetch(`${apiBase()}/api/ipcams/${cam.stream_key}/calibration`),
        fetch(`${apiBase()}/api/inference/weights`),
      ]);
      if (!calibrationResp.ok) throw new Error("기준점 정보를 불러오지 못했습니다.");
      if (!weightsResp.ok) throw new Error("활성 가중치 정보를 불러오지 못했습니다.");
      const calibration = await calibrationResp.json();
      const nextWeights = (await weightsResp.json()) as WeightsStatus;
      const nextClasses = await loadAllLaneClasses(nextWeights);
      setMeasureCanEnable(Boolean(calibration.enabled && calibration.homography));
      setWeights(nextWeights);
      setLaneClasses(nextClasses);
      await syncMeasurementsWithLanes(nextClasses);
      setMeasureTarget(cam);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "자동 측정 설정에 실패했습니다.");
    } finally {
      setMeasureBusyKey(null);
    }
  }

  async function readResponseError(response: Response, fallback: string): Promise<string> {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null;
    return typeof body?.detail === "string" ? body.detail : fallback;
  }

  async function applyLaneWeightsChange(
    response: Response,
    fallbackMessage: string,
  ): Promise<void> {
    if (!response.ok) throw new Error(await readResponseError(response, fallbackMessage));
    const nextWeights = (await response.json()) as WeightsStatus;
    const nextClasses = await loadAllLaneClasses(nextWeights);
    setWeights(nextWeights);
    setLaneClasses(nextClasses);
    await syncMeasurementsWithLanes(nextClasses);
  }

  async function uploadWeights(lane: string, file: File) {
    setWeightsBusy(true);
    setWeightsError("");
    try {
      const form = new FormData();
      form.append("file", file);
      await applyLaneWeightsChange(
        await fetch(`${apiBase()}/api/inference/lanes/${lane}/weights`, {
          method: "POST",
          body: form,
        }),
        "가중치 업로드에 실패했습니다.",
      );
    } catch (reason) {
      setWeightsError(reason instanceof Error ? reason.message : "가중치 업로드에 실패했습니다.");
    } finally {
      setWeightsBusy(false);
    }
  }

  async function resetWeights(lane: string) {
    setWeightsBusy(true);
    setWeightsError("");
    try {
      await applyLaneWeightsChange(
        await fetch(`${apiBase()}/api/inference/lanes/${lane}/weights`, { method: "DELETE" }),
        "업로드 가중치 제거에 실패했습니다.",
      );
    } catch (reason) {
      setWeightsError(
        reason instanceof Error ? reason.message : "업로드 가중치 제거에 실패했습니다.",
      );
    } finally {
      setWeightsBusy(false);
    }
  }

  async function applyAutoMeasurement(enabled: boolean, classes: SelectedYoloClass[]) {
    if (!measureTarget) return;
    setMeasureSaving(true);
    setError("");
    try {
      if (!weights) throw new Error("활성 가중치 정보를 불러오지 못했습니다.");
      if (enabled && !weights.lanes.target) throw new Error("상대 레인 가중치 업로드 필요");
      const resp = await fetch(`${apiBase()}/api/ipcams/${measureTarget.stream_key}/inference`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          enabled
            ? {
                enabled: true,
                models: [ANCHOR_LANE, TARGET_LANE],
                conf_threshold: minimumClassConfidence(classes),
              }
            : { enabled: false },
        ),
      });
      if (!resp.ok) throw new Error("자동 측정 설정을 저장하지 못했습니다.");
      setAutoMeasurements((current) => ({
        ...current,
        [measureTarget.stream_key]: { enabled, classes },
      }));
      setMeasureTarget(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "자동 측정 설정을 저장하지 못했습니다.");
    } finally {
      setMeasureSaving(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-title dashboard-title">
          <svg
            className="ico ico-lg dashboard-mark"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M3 17V8.5A1.5 1.5 0 0 1 4.5 7H8l2.2 4.5H12V17" />
            <path d="M16 17V4" />
            <path d="M16 13h3.5" />
            <path d="M16 17h4.5" />
            <circle cx="6.5" cy="18.5" r="1.8" />
            <circle cx="13.5" cy="18.5" r="1.8" />
          </svg>
          <h1>실시간 모니터</h1>
        </div>
        <div className="topbar-right">
          <div className="sysbar" role="status">
            <span className={online === cams.length && cams.length > 0 ? "sysbar-state ok" : "sysbar-state warn"}>
              <svg
                className="ico ico-sm"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M6.5 8.2a7 7 0 0 0 0 7.6M17.5 8.2a7 7 0 0 1 0 7.6" />
                <path d="M3.8 5.5a11 11 0 0 0 0 13M20.2 5.5a11 11 0 0 1 0 13" />
                <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
              </svg>
              <i className="sysbar-dot" />{online === cams.length && cams.length > 0 ? "시스템 정상" : "상태 확인"}
            </span>
            <span className="sysbar-sep">·</span>
            <span className="sysbar-item mono">온라인 {online}/{cams.length}</span>
          </div>
          <button
            className="btn primary"
            disabled={atCap}
            onClick={() => {
              setEditCam(null);
              setFormOpen(true);
            }}
          >
            ＋ 카메라 등록
          </button>
        </div>
      </header>

      <div className="content cameras-content">
        {error && <p className="form-error">{error}</p>}

        <section className="kpis" aria-label="카메라 현황">
          <div className="panel kpi">
            <div className="kpi-label">전체 카메라</div>
            <div className="kpi-value">{cams.length}<span className="kpi-sub"> 대</span></div>
            <div className="hint">등록된 스트림</div>
          </div>
          <div className="panel kpi kpi-ok">
            <div className="kpi-label">온라인</div>
            <div className="kpi-value">{online}<span className="kpi-sub"> 대</span></div>
            <div className="hint">영상 수신 가능</div>
          </div>
          <div className="panel kpi kpi-muted">
            <div className="kpi-label">오프라인</div>
            <div className="kpi-value">{cams.length - online}<span className="kpi-sub"> 대</span></div>
            <div className="hint">연결 확인 필요</div>
          </div>
          <div className="panel kpi">
            <div className="kpi-label">등록 용량</div>
            <div className="kpi-value">{cams.length}<span className="kpi-sub"> / {maxIpcams}</span></div>
            <div className="hint">최대 카메라 수</div>
          </div>
        </section>

        <section className="panel table-panel camera-table-panel">
          <div className="panel-head">
            <svg
              className="ico panel-head-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1.1-1.7A1 1 0 0 1 9.1 4h5.8a1 1 0 0 1 .8.4L16.8 6h1.7A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
              <circle cx="12" cy="12.5" r="3.2" />
            </svg>
            <strong>카메라 목록</strong>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 180 }}>카메라</th>
                  <th>RTSP URL</th>
                  <th style={{ width: 110 }}>상태</th>
                  <th style={{ width: 80 }}>FPS</th>
                  <th style={{ width: 330, textAlign: "right" }}>관리</th>
                </tr>
              </thead>
              <tbody>
                {cams.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty-cell">등록된 카메라가 없습니다.</td>
                  </tr>
                )}
                {cams.map((cam) => {
                  const st = stats[cam.stream_key];
                  const active = st?.active ?? false;
                  return (
                    <tr key={cam.id}>
                      <td>
                        <div className="cam-id">CAM-{String(cam.id).padStart(2, "0")}</div>
                        <div className="cam-name">{cam.name}</div>
                      </td>
                      <td className="url-cell" title={cam.rtsp_url}>{cam.rtsp_url}</td>
                      <td>
                        <span className={active ? "status status-on" : "status status-off"}>
                          <i className="dot" />{active ? "온라인" : "오프라인"}
                        </span>
                      </td>
                      <td className="mono">{active && fps[cam.stream_key] != null ? fps[cam.stream_key].toFixed(1) : "—"}</td>
                      <td className="table-actions">
                        <button className="btn sm icon-btn" onClick={() => onCalibrate(cam)}>
                          <svg
                            className="ico ico-sm"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <circle cx="12" cy="12" r="7.5" />
                            <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" />
                            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
                          </svg>
                          기준점 입력
                        </button>
                        <button
                          className="btn sm measure-toggle icon-btn"
                          disabled={measureBusyKey === cam.stream_key}
                          title="자동 거리측정 설정"
                          onClick={() => openAutoMeasurementSettings(cam)}
                        >
                          <svg
                            className="ico ico-sm"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <path d="M3 12h18" />
                            <path d="m6 9-3 3 3 3" />
                            <path d="m18 9 3 3-3 3" />
                            <path d="M9 10.5v3M12 10.5v3M15 10.5v3" />
                          </svg>
                          거리 측정
                        </button>
                        <button
                          className="btn sm icon-btn"
                          onClick={() => {
                            setEditCam(cam);
                            setFormOpen(true);
                          }}
                        >
                          <svg
                            className="ico ico-sm"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z" />
                            <path d="m13.5 6.5 4 4" />
                          </svg>
                          RTSP 수정
                        </button>
                        <button className="btn sm danger icon-btn" onClick={() => deleteCam(cam)}>
                          <svg
                            className="ico ico-sm"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <path d="M4 7h16" />
                            <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
                            <path d="m6.5 7 .9 12.1A1.9 1.9 0 0 0 9.3 21h5.4a1.9 1.9 0 0 0 1.9-1.9L17.5 7" />
                            <path d="M10.5 11v6M13.5 11v6" />
                          </svg>
                          삭제
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel live-grid-panel">
          <div className="panel-head row-between">
            <div className="panel-head-title">
              <svg
                className="ico panel-head-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
                <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
                <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
                <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
              </svg>
              <h2>실시간 카메라</h2>
            </div>
            <span className="badge none">{cams.length} CH</span>
          </div>
          <div className="live-grid-body">
            <CameraGrid cams={cams} onFps={handleFps} autoMeasurements={weights == null ? {} : autoMeasurements} />
          </div>
        </section>
      </div>

      <CameraFormModal
        open={formOpen}
        editCam={editCam}
        onClose={() => setFormOpen(false)}
        onSave={handleSave}
      />
      <MeasurementClassModal
        open={measureTarget != null}
        cameraName={measureTarget?.name ?? ""}
        laneClasses={laneClasses}
        initialEnabled={
          measureTarget ? autoMeasurements[measureTarget.stream_key]?.enabled ?? false : false
        }
        initialSelection={
          measureTarget
            ? autoMeasurements[measureTarget.stream_key]?.classes ?? EMPTY_CLASSES
            : EMPTY_CLASSES
        }
        canEnable={measureCanEnable}
        saving={measureSaving}
        weights={weights}
        weightsBusy={weightsBusy}
        weightsError={weightsError}
        selectionResetToken={selectionResetToken}
        onClose={() => setMeasureTarget(null)}
        onConfirm={applyAutoMeasurement}
        onUploadWeights={uploadWeights}
        onResetWeights={resetWeights}
      />
    </>
  );
}
