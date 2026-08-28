import { useEffect, useRef, useState, useCallback } from "react";
import Modal from "./Modal";
import { videoClientToNatural, containRect } from "../utils/videoCoords";

const MIN_POINTS = 4;
export const MAX_POINTS = 20;

type ModalStep = "PLACING_POINTS" | "DISTANCE_INPUT" | "SAVING" | "RESULT";

interface CalibPoint {
  px: [number, number];
  error: number | null;
}

// CalibrationUpdate 계약(spec) — phase3 PUT body. enabled = 측정 표시 on/off.
export interface CalibrationUpdate {
  pixel_points: number[][];
  world_points: number[][];
  enabled: boolean;
  native_size: [number, number] | null;
}

// CalibrationState(spec) — phase3 GET 응답. phase2 는 local 복원용으로만 사용.
export interface CalibrationState {
  enabled: boolean;
  pixel_points: number[][] | null;
  world_points: number[][] | null;
  homography: number[][] | null;
  k1: number;
  native_size: [number, number] | null;
  reprojection_errors: number[] | null;
  mean_reprojection_error: number | null;
  inlier_mask: number[] | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  cameraName: string;
  // MeasurePage 가 live <video> 프레임을 grab 한 still dataURL(videoWidth×videoHeight).
  // prime 의 /snapshot.jpg fetch 대체 — img-natural-px === video-natural-px 동일 좌표계.
  snapshotUrl: string | null;
  // 기존 calibration(phase3 GET). 없으면 새 설정. phase2 는 보통 null.
  initialState?: CalibrationState | null;
  // 저장 — phase2 는 local(부모가 mock 처리), phase3 에서 sign-mask 탐색+PUT 으로 교체.
  // 반환 CalibrationState(또는 null=실패)면 reprojection 결과 표시.
  onSave: (payload: CalibrationUpdate) => Promise<CalibrationState | null>;
  // inline=true 면 자체 <Modal> 래퍼 없이 콘텐츠만 반환(B1 탭 패널용). 부모(측정 탭 모달)가
  // 모달 셸·닫기를 소유하므로 title/취소 버튼 생략. 삼각측량·picking·API 로직은 동일.
  inline?: boolean;
  // 저장이 최종 성공(RESULT 도달)했을 때 1회 호출 — 부모가 측정 모드로 자동 전환하는 신호.
  onSaved?: (state: CalibrationState) => void;
}

/** 점 개수에 따라 필요한 거리 쌍 목록 반환 (0-indexed) */
function getRequiredPairs(n: number): [number, number][] {
  if (n < 2) return [];
  const pairs: [number, number][] = [[0, 1]];
  for (let i = 2; i < n; i++) {
    pairs.push([0, i]);
    pairs.push([1, i]);
  }
  return pairs;
}

/** 점 idx 삭제 시 거리 맵을 점 정체성 기준으로 remap. idx 초과 점 인덱스는 1 감소,
 *  idx 를 끝점으로 갖는 거리는 폐기. anchor(0/1) 삭제로 삼각측량 basis 가 바뀌면 측정 안 한
 *  pair 는 required 에 남지 않아 자연히 blank → 재입력 유도(save 게이트가 미완 카운트 표시).
 *  (기존 버그: 옛 pair키로 그대로 복사 → 중간 점 삭제 시 다른 물리쌍에 옛 거리 재사용 → 잘못된 H.) */
export function remapDistancesAfterRemoval(
  distances: Record<string, string>,
  idx: number,
  newN: number,
): Record<string, string> {
  const required = new Set(getRequiredPairs(newN).map(([a, b]) => `${a}-${b}`));
  const next: Record<string, string> = {};
  for (const [key, val] of Object.entries(distances)) {
    const [a, b] = key.split("-").map(Number);
    if (a === idx || b === idx) continue; // 삭제 점을 끝점으로 갖는 거리 → 폐기
    const na = a < idx ? a : a - 1;
    const nb = b < idx ? b : b - 1;
    const nkey = `${Math.min(na, nb)}-${Math.max(na, nb)}`;
    if (required.has(nkey)) next[nkey] = val;
  }
  return next;
}

/** 거리 → 월드 좌표 변환 (삼각측량). P0=(0,0), P1=(d01,0), 이후 y는 항상 양수 (부호는 별도 탐색) */
function distancesToWorldPointsBase(
  distances: Record<string, string>,
  n: number,
): [number, number][] | null {
  if (n < MIN_POINTS) return null;

  const d = (a: number, b: number): number => {
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    return parseFloat(distances[key]) / 100; // 입력은 cm → 월드 좌표는 m 로 환산
  };

  const world: [number, number][] = [];
  world.push([0, 0]);

  const d01 = d(0, 1);
  if (isNaN(d01) || d01 <= 0) return null;
  world.push([d01, 0]);

  for (let i = 2; i < n; i++) {
    const d0i = d(0, i);
    const d1i = d(1, i);
    if (isNaN(d0i) || isNaN(d1i) || d0i <= 0 || d1i <= 0) return null;

    const x = (d0i * d0i - d1i * d1i + d01 * d01) / (2 * d01);
    const ySq = d0i * d0i - x * x;
    const yAbs = ySq > 0 ? Math.sqrt(ySq) : 0;
    world.push([x, yAbs]);
  }

  return world;
}

/** signMask 비트로 y부호 적용. bit i-2가 1이면 y 뒤집기. */
function applySignMask(base: [number, number][], mask: number): [number, number][] {
  return base.map((p, i) => {
    if (i < 2) return p;
    const flip = (mask >> (i - 2)) & 1;
    return flip ? [p[0], -p[1]] as [number, number] : p;
  });
}

/** 월드 좌표 → 거리 맵 역산 (기존 캘리브레이션 복원용) */
function worldPointsToDistances(wp: number[][]): Record<string, string> {
  const dist: Record<string, string> = {};
  const n = wp.length;
  if (n >= 2) {
    dist["0-1"] = (Math.sqrt(
      (wp[1][0] - wp[0][0]) ** 2 + (wp[1][1] - wp[0][1]) ** 2,
    ) * 100).toFixed(1); // m → cm (입력 단위)
  }
  for (let i = 2; i < n; i++) {
    dist[`0-${i}`] = (Math.sqrt(
      (wp[i][0] - wp[0][0]) ** 2 + (wp[i][1] - wp[0][1]) ** 2,
    ) * 100).toFixed(1);
    dist[`1-${i}`] = (Math.sqrt(
      (wp[i][0] - wp[1][0]) ** 2 + (wp[i][1] - wp[1][1]) ** 2,
    ) * 100).toFixed(1);
  }
  return dist;
}

// open 복원 시 쓸 enabled 초기값. initialState 는 fresh 카메라에서도 백엔드 default
// calibration state 객체(homography:null, enabled:false)로 truthy 라, "data 존재"만 보고
// enabled 를 복원하면 새 calibration 을 off 로 덮는다(fix.ckpt3 회귀). points 복원과 동일한
// "실 calibration(homography 존재)일 때만" 가드를 써야 fresh 는 기본 on 을 유지한다.
export function restoreEnabled(data: CalibrationState | null | undefined): boolean {
  return data?.homography ? data.enabled : true;
}

// sign-mask 전수탐색: 2^(n-2) 조합을 onSave 로 시도해 mean_reprojection_error 최소를 채택.
// prime L293-316 로직 유지(phase3 에서 onSave 가 실 PUT). 거리경보/inlier strip.
// 모든 조합이 검증실패(throw)하면 마지막 사유(lastError)를 함께 반환 — 사용자에게 구체 표시용.
// (pixel_points 검증[공선 등]은 mask 와 무관하게 동일 실패 → 첫 사유가 곧 전체 사유.)
export async function searchBestSignMask(
  baseWp: [number, number][],
  pixelPoints: number[][],
  enabled: boolean,
  onSave: Props["onSave"],
  nativeSize: [number, number] | null = null,
): Promise<{ best: CalibrationState | null; lastError: string | null }> {
  const numCombos = 1 << (pixelPoints.length - 2);
  let best: CalibrationState | null = null;
  let bestWp: [number, number][] | null = null; // best 후보의 world_points payload(재저장용)
  let bestError = Infinity;
  // onSave 는 실 PUT 이라 매 후보가 DB 에 커밋된다. DB 최신 = 마지막으로 성공 저장된 후보.
  // 그게 best 가 아니면(early break 없이 loop 종료 시) DB 는 '더 나쁜' orientation 을 갖는다.
  let bestIsLastSaved = false;
  let lastError: string | null = null;
  for (let mask = 0; mask < numCombos; mask++) {
    const wp = applySignMask(baseWp, mask);
    try {
      const result = await onSave({
        pixel_points: pixelPoints,
        world_points: wp,
        enabled,
        native_size: nativeSize,
      });
      if (!result) continue; // 검증실패 → DB 미커밋(last-saved 불변)
      const err = result.mean_reprojection_error ?? Infinity;
      if (err < bestError) {
        bestError = err;
        best = result;
        bestWp = wp;
        bestIsLastSaved = true;
      } else {
        bestIsLastSaved = false; // 더 나쁜 이 후보가 지금 DB 최신
      }
      if (err < 1) break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
  }
  // DB 최신이 best 가 아니면 best 로 1회 재PUT → DB 가 최적 orientation 을 영속.
  if (best && bestWp && !bestIsLastSaved) {
    try {
      const resaved = await onSave({
        pixel_points: pixelPoints,
        world_points: bestWp,
        enabled,
        native_size: nativeSize,
      });
      if (resaved) best = resaved;
    } catch {
      // 재저장 실패: loop 에서 얻은 메모리 best 반환 — UI 는 정확, DB 만 직전 상태.
    }
  }
  return { best, lastError };
}

function CalibrationModal({ open, onClose, cameraName, snapshotUrl, initialState, onSave, inline, onSaved }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [points, setPoints] = useState<CalibPoint[]>([]);
  const [distances, setDistances] = useState<Record<string, string>>({});
  const [step, setStep] = useState<ModalStep>("PLACING_POINTS");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [meanError, setMeanError] = useState<number | null>(null);
  // enabled = 측정 표시 on/off (spec/decisions). 사용자가 토글로 정하고 PUT payload 로 저장.
  const [enabled, setEnabled] = useState(true);
  // 스냅샷 img 의 natural 크기 — **state**(onLoad 시 set → re-render). 마커를 ref(getBoundingClientRect)
  // 로 그리면 복원 calibration(클릭 없는 경로)에서 ref=null/타이밍 문제로 안 뜬다. natSize 로
  // **퍼센트 위치**(natural px ÷ naturalW × 100%) 계산 → ref 무관, 복원·fresh 둘 다 항상 표시.
  // .calib-img-wrap(16:9) + 16:9 스냅샷 → object-fit:contain letterbox 0 → 퍼센트가 정확.
  const [natSize, setNatSize] = useState<{ w: number; h: number } | null>(null);
  // 정밀 클릭용 십자선 가이드 — 마우스 위치(%). null = 이미지 밖.
  const [cross, setCross] = useState<{ x: number; y: number } | null>(null);
  // .calib-img-wrap 렌더 크기 — 마커를 img 의 object-fit:contain rect 안에 정확히 놓기 위함
  // (비-16:9 스냅샷의 letterbox/pillarbox 정렬, finding #3).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapSize, setWrapSize] = useState<{ w: number; h: number } | null>(null);

  // 스냅샷이 바뀌면 natSize 를 그 img 의 naturalWidth 가 준비되는 즉시 캡처한다.
  // **폴링** 방식 — onLoad/콜백ref/layoutEffect 타이밍에 의존하지 않아(복원 경로에서 그것들이
  // 미발화하던 게 마커 0개의 원인) 가장 견고. naturalWidth>0 되면 set 하고 멈춤.
  useEffect(() => {
    setNatSize(null);
    if (!snapshotUrl) return;
    let cancelled = false;
    const tryCapture = () => {
      if (cancelled) return true;
      const img = imgRef.current;
      if (img && img.naturalWidth > 0) {
        setNatSize({ w: img.naturalWidth, h: img.naturalHeight });
        return true;
      }
      return false;
    };
    if (tryCapture()) return;
    const id = window.setInterval(() => {
      if (tryCapture()) window.clearInterval(id);
    }, 50);
    const stop = window.setTimeout(() => window.clearInterval(id), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.clearTimeout(stop);
    };
  }, [snapshotUrl]);

  // .calib-img-wrap 렌더 크기 관측 — 마커 layer 를 img 의 contain rect 로 맞추기 위함.
  // wrap 은 snapshotUrl 있을 때만 렌더 → [snapshotUrl] 후 ref 존재. ResizeObserver 로 반응형.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setWrapSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [snapshotUrl]);

  const resetState = useCallback(() => {
    setPoints([]);
    setDistances({});
    setStep("PLACING_POINTS");
    setSaveErr("");
    setMeanError(null);
    setEnabled(true); // 새 calibration 기본 on (restore 시 아래 effect 가 저장값으로 덮음)
  }, []);

  // open 시 기존 calibration 복원(initialState). phase2 는 보통 null → 빈 상태.
  useEffect(() => {
    if (!open) return;
    resetState();
    const data = initialState;
    setEnabled(restoreEnabled(data)); // 저장된 측정 표시 on/off 복원(fresh 는 기본 on)
    if (data?.pixel_points && data.world_points) {
      const restored: CalibPoint[] = data.pixel_points.map((px, i) => ({
        px: [px[0], px[1]] as [number, number],
        error: data.reprojection_errors?.[i] ?? null,
      }));
      setPoints(restored);
      setDistances(worldPointsToDistances(data.world_points));
      if (data.homography) {
        setStep("RESULT");
        setMeanError(data.mean_reprojection_error ?? null);
      } else {
        setStep(restored.length >= MIN_POINTS ? "DISTANCE_INPUT" : "PLACING_POINTS");
      }
    }
  }, [open, initialState, resetState]);

  // 스냅샷 still(<img>) 클릭 → natural px. measure <video> 와 **동일한 videoClientToNatural
  // util·동일 contain-fit 보정**을 거친다(dev #22 일반화). still 은 MeasurePage 가
  // videoWidth×videoHeight 로 캡처 → img.naturalW/H = videoWidth×videoHeight 라 둘이
  // 동일 natural-px 좌표계로 수렴(CRITICAL 불변식: calibration H 가 측정 클릭에 일관 적용).
  const handleImgClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (step === "SAVING") return;
    const img = imgRef.current;
    if (!img) return;
    const nat = videoClientToNatural(img, e.clientX, e.clientY);
    if (!nat) return; // letterbox bar 클릭 등
    const [u, v] = [Math.round(nat[0]), Math.round(nat[1])];

    // 복원된 calibration(RESULT) 위에서 클릭해도 기존 점에 **추가**(편집) — 리셋하지 않는다.
    // 점 전체를 새로 찍으려면 "초기화" 버튼을 쓴다. (기존 점 add 시 거리 미완은 저장 버튼이
    // "거리 N개 중 M개" 구체 메시지로 안내 — #42, silent-disable 아님.)
    if (points.length >= MAX_POINTS) return;
    setPoints((prev) => [...prev, { px: [u, v], error: null }]);
    setSaveErr("");
    setMeanError(null);
    const newCount = points.length + 1;
    setStep(newCount >= MIN_POINTS ? "DISTANCE_INPUT" : "PLACING_POINTS");
  };

  const removePoint = (idx: number) => {
    const newN = points.length - 1;
    setPoints((prev) => prev.filter((_, i) => i !== idx));
    setDistances((prev) => remapDistancesAfterRemoval(prev, idx, newN));
    setSaveErr("");
    setMeanError(null);
    if (newN < MIN_POINTS) setStep("PLACING_POINTS");
    else if (step === "RESULT") setStep("DISTANCE_INPUT");
  };

  const updateDistance = (key: string, value: string) => {
    setDistances((prev) => ({ ...prev, [key]: value }));
    if (step === "RESULT") setStep("DISTANCE_INPUT");
  };

  const requiredPairs = getRequiredPairs(points.length);
  const filledCount = requiredPairs.filter(([a, b]) => {
    const v = distances[`${a}-${b}`];
    return v && v.trim() !== "" && parseFloat(v) > 0;
  }).length;
  const allDistancesComplete =
    points.length >= MIN_POINTS && filledCount === requiredPairs.length;

  const handleSave = async () => {
    setSaveErr("");
    if (points.length < MIN_POINTS) {
      setSaveErr(`최소 ${MIN_POINTS}점을 배치해주세요`);
      return;
    }
    if (!allDistancesComplete) {
      // 구체 사유 — 누적된 점으로 필요 pair 가 많아진 경우 사용자가 즉시 인지하도록 카운트 표시.
      setSaveErr(
        `거리 ${requiredPairs.length}개 중 ${filledCount}개만 입력됨 — 나머지를 채우거나 "초기화"로 점을 다시 찍으세요`,
      );
      return;
    }
    const baseWp = distancesToWorldPointsBase(distances, points.length);
    if (!baseWp) {
      setSaveErr("거리 값이 올바르지 않습니다 — 삼각형 부등식을 확인하세요");
      return;
    }

    setStep("SAVING");
    setSaving(true);
    try {
      const nativeSize: [number, number] | null = natSize
        ? [natSize.w, natSize.h]
        : null;
      const { best: data, lastError } = await searchBestSignMask(
        baseWp,
        points.map((p) => p.px),
        enabled, // 사용자가 토글한 측정 표시 on/off 를 그대로 저장(하드코딩 제거, finding #4)
        onSave,
        nativeSize,
      );
      if (!data) {
        // 검증실패 구체 사유 표시(공선/중복/길이불일치 등) — 일반 메시지 대신 backend detail.
        setSaveErr(
          lastError
            ? `캘리브레이션 실패: ${lastError}`
            : "캘리브레이션 실패 — 점 위치와 거리를 확인해주세요",
        );
        setStep("DISTANCE_INPUT");
        return;
      }
      setPoints((prev) =>
        prev.map((p, i) => ({ ...p, error: data.reprojection_errors?.[i] ?? null })),
      );
      setMeanError(data.mean_reprojection_error ?? null);
      setStep("RESULT");
      onSaved?.(data); // 최종 성공 → 부모가 측정 모드로 자동 전환
    } catch (e) {
      setSaveErr(String(e));
      setStep("DISTANCE_INPUT");
    } finally {
      setSaving(false);
    }
  };

  // Step indicator
  const steps: { key: ModalStep; label: string }[] = [
    { key: "PLACING_POINTS", label: "점 배치" },
    { key: "DISTANCE_INPUT", label: "거리 입력" },
    { key: "SAVING", label: "계산 중" },
    { key: "RESULT", label: "결과" },
  ];
  const stepIndex = steps.findIndex((s) => s.key === step);

  const content = (
    <>
      {/* Step Indicator */}
      <div className="calib-steps">
        {steps.map((s, i) => (
          <span
            key={s.key}
            className={
              i < stepIndex ? "calib-step done" : i === stepIndex ? "calib-step current" : "calib-step"
            }
          >
            <svg
              className="ico calib-step-check"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
            {i + 1}. {s.label}
          </span>
        ))}
      </div>

      <p className="hint">
        시야 전체에 {MIN_POINTS}~{MAX_POINTS}개 기준점을 분산 클릭하세요. 점1을 원점으로,
        줄자로 점 사이 거리를 측정하여 입력합니다.
      </p>

      <div className="calib-main">
        {/* Left: snapshot */}
        <div className="calib-snapshot">
          {!snapshotUrl ? (
            <p className="hint">스냅샷을 가져오는 중…</p>
          ) : (
            <div className="calib-img-wrap" ref={wrapRef}>
              <img
                ref={imgRef}
                src={snapshotUrl}
                alt="snapshot"
                className="calib-img"
                style={{
                  cursor:
                    points.length >= MAX_POINTS || step === "SAVING" ? "default" : "crosshair",
                }}
                onClick={handleImgClick}
                onMouseMove={(e) => {
                  if (step === "SAVING") return setCross(null);
                  const img = imgRef.current;
                  if (!img) return;
                  const r = img.getBoundingClientRect();
                  setCross({
                    x: ((e.clientX - r.left) / r.width) * 100,
                    y: ((e.clientY - r.top) / r.height) * 100,
                  });
                }}
                onMouseLeave={() => setCross(null)}
                draggable={false}
              />
              {/* 정밀 클릭 십자선 가이드 — 마우스 따라 이미지 가로·세로 선(점 정확히 겨냥). */}
              {cross && step !== "SAVING" && (
                <>
                  <div className="calib-cross-v" style={{ left: `${cross.x}%` }} />
                  <div className="calib-cross-h" style={{ top: `${cross.y}%` }} />
                </>
              )}
              {/* 마커 layer = img 의 object-fit:contain rect(natSize + wrapSize → containRect).
                  마커는 그 layer 안에서 natural 퍼센트로 배치 → 비-16:9 스냅샷에서도
                  letterbox/pillarbox 만큼 정확히 정렬(클릭 매핑과 동일 기하, finding #3).
                  복원·fresh 둘 다 natSize·wrapSize 만 있으면 항상 렌더(클릭 불필요). */}
              {natSize &&
                wrapSize &&
                (() => {
                  const r = containRect(wrapSize.w, wrapSize.h, natSize.w, natSize.h);
                  return (
                    <div
                      className="calib-marker-layer"
                      style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
                    >
                      {points.map((pt, i) => (
                        <div
                          key={i}
                          className="calib-marker"
                          style={{
                            left: `${(pt.px[0] / natSize.w) * 100}%`,
                            top: `${(pt.px[1] / natSize.h) * 100}%`,
                          }}
                        >
                          {i + 1}
                        </div>
                      ))}
                    </div>
                  );
                })()}
            </div>
          )}
          <div className="calib-badge">
            {points.length} / {MIN_POINTS}-{MAX_POINTS}점
            {points.length < MIN_POINTS && ` (최소 ${MIN_POINTS}점)`}
          </div>
        </div>

        {/* Right: distance table */}
        <div className="calib-dist">
          {points.length < 2 ? (
            <p className="hint">이미지를 클릭하여 점을 2개 이상 배치하세요</p>
          ) : (
            <>
              <div className="calib-chips">
                {points.map((pt, i) => (
                  <span key={i} className="calib-chip">
                    <span className="calib-chip-dot">{i + 1}</span>
                    {pt.error !== null && (
                      <span className="calib-chip-err">{pt.error.toFixed(1)}px</span>
                    )}
                    <button
                      className="calib-chip-del"
                      onClick={() => removePoint(i)}
                      disabled={step === "SAVING"}
                      title="삭제"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>

              <table className="calib-dist-table">
                <thead>
                  <tr>
                    <th>구간</th>
                    <th style={{ width: 110 }}>거리 (cm)</th>
                  </tr>
                </thead>
                <tbody>
                  {requiredPairs.map(([a, b]) => {
                    const key = `${a}-${b}`;
                    return (
                      <tr key={key}>
                        <td>
                          점{a + 1} → 점{b + 1}
                        </td>
                        <td>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            placeholder="cm"
                            value={distances[key] || ""}
                            onChange={(e) => updateDistance(key, e.target.value)}
                            disabled={step === "SAVING"}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="hint">
                필요: {requiredPairs.length}개 · 입력: {filledCount}개
              </p>
            </>
          )}

          {step === "RESULT" && meanError !== null && (
            <p className="calib-result">평균 reprojection 오차: {meanError.toFixed(1)}px</p>
          )}
        </div>
      </div>

      {/* 측정 표시 on/off 토글 — 사용자 선택을 PUT payload(enabled)로 저장(finding #4).
         off 로 저장하면 그리드/측정뷰가 homography 가 있어도 측정을 비활성화한다. */}
      <label className="calib-enabled">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled={saving}
        />
        측정 표시 활성화 (calibration on/off)
      </label>

      {saveErr && <p className="form-error">{saveErr}</p>}

      <div className="modal-actions">
        <button onClick={resetState} disabled={saving || points.length === 0}>
          초기화
        </button>
        {/* 취소(닫기)는 standalone 모달에서만 — inline(탭) 모드는 부모 모달이 닫기 소유. */}
        {!inline && (
          <button onClick={onClose} disabled={saving}>
            취소
          </button>
        )}
        {/* 저장은 saving 중에만 비활성 — 거리 미완 등은 click 시 handleSave 가 구체 사유 표시.
            (이전엔 !allDistancesComplete 로 silent disable → 점이 누적돼 필요 pair 가 많아지면
            버튼이 말없이 죽어 "저장 눌러도 안 넘어감"으로 보였음.) */}
        <button className="primary" onClick={handleSave} disabled={saving}>
          {saving ? "저장 중…" : "저장"}
        </button>
      </div>
    </>
  );

  // inline(B1 탭 패널): 콘텐츠만. standalone: 기존처럼 <Modal> 래핑(backward-compat).
  if (inline) return content;
  return (
    <Modal open={open} onClose={onClose} title={`거리측정 calibration — ${cameraName}`} maxWidth={820}>
      {content}
    </Modal>
  );
}

export default CalibrationModal;
