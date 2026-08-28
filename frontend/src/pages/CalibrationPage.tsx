import { useCallback, useEffect, useRef, useState } from "react";
import WhepPlayer from "../components/WhepPlayer";
import CalibrationModal, {
  type CalibrationState,
  type CalibrationUpdate,
} from "../components/CalibrationModal";
import { apiBase } from "../hooks/useApi";
import type { Cam } from "./CamerasPage";

interface Props {
  cam: Cam;
  onBack: () => void;
}

// 풀페이지 calibration 화면 — CamerasPage 의 "calibration" 버튼에서 네비게이션.
// 큰 영상/스냅샷 위에 지면 기준점 4~12 picking + 거리입력 + 저장(삼각측량·API 는 CalibrationModal verbatim).
// WHEP <video> 는 페이지 메인 콘텐츠로 항상 렌더 → 디코딩 유지 → 스냅샷이 실 프레임(검은 화면 방지).
// 첫 디코딩 프레임 도착 시(requestVideoFrameCallback) 자동 grab.
export default function CalibrationPage({ cam, onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [initialState, setInitialState] = useState<CalibrationState | null>(null);
  const [savedMsg, setSavedMsg] = useState("");

  // 진입 시 저장된 calibration 복원(있으면 점/거리 prefill).
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`${apiBase()}/api/ipcams/${cam.stream_key}/calibration`);
        if (!resp.ok) return;
        setInitialState(await resp.json());
      } catch {
        /* 백엔드/네트워크 오류 — 새 calibration 으로 진행 */
      }
    })();
  }, [cam.stream_key]);

  // <video> 현재 프레임 → canvas → {url, black}. video 가 항상 렌더(디코딩)라 실 프레임.
  // 디코딩 워밍업 중 첫 프레임이 검을 수 있어 평균 luma 로 black 판정(검으면 재시도).
  const grabSnapshot = useCallback((): { url: string; black: boolean } | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
    // black 판정 — 축소 샘플 평균 luma. (검은 프레임 grab 방지)
    const sw = 32;
    const sh = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * sw));
    const sc = document.createElement("canvas");
    sc.width = sw;
    sc.height = sh;
    const sctx = sc.getContext("2d")!;
    sctx.drawImage(canvas, 0, 0, sw, sh);
    const d = sctx.getImageData(0, 0, sw, sh).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    const avgLuma = sum / (d.length / 4);
    return { url: canvas.toDataURL("image/jpeg"), black: avgLuma < 8 };
  }, []);

  // 자동 grab — **검은 프레임이 아닌 실 프레임**이 나올 때까지 재시도(디코딩 워밍업 대응).
  // requestVideoFrameCallback 으로 presented frame 마다 재시도, 미지원 시 폴링. non-black 잡으면 멈춤.
  useEffect(() => {
    if (snapshot) return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let tries = 0;

    type RVFCVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const v = video as RVFCVideo;
    const hasRVFC = typeof v.requestVideoFrameCallback === "function";

    const tryGrab = () => {
      if (cancelled) return;
      tries += 1;
      const res = grabSnapshot();
      if (res && !res.black) {
        setSnapshot(res.url); // 실 프레임 확보 — 멈춤
        return;
      }
      // 아직 프레임 없음/검은 프레임 → 다음 frame 에 재시도(최대 ~120회 ≈ 충분한 워밍업).
      if (tries < 120) {
        if (hasRVFC) v.requestVideoFrameCallback!(() => tryGrab());
        else window.setTimeout(tryGrab, 250);
      } else if (res) {
        setSnapshot(res.url); // 안전장치: 끝내 non-black 못 잡으면 마지막 프레임이라도(드묾)
      }
    };

    if (hasRVFC) v.requestVideoFrameCallback!(() => tryGrab());
    else {
      const onLoaded = () => window.setTimeout(tryGrab, 200);
      video.addEventListener("loadeddata", onLoaded);
      window.setTimeout(tryGrab, 300);
      return () => {
        cancelled = true;
        video.removeEventListener("loadeddata", onLoaded);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [snapshot, grabSnapshot]);

  // 수동 갱신 — 현재 프레임 강제 grab(black 여부 무관, 사용자가 원하는 시점).
  const regrabSnapshot = () => {
    const res = grabSnapshot();
    if (res) setSnapshot(res.url);
  };

  // 저장 — PUT /api/ipcams/{key}/calibration. sign-mask 전수탐색이 조합마다 호출(CalibrationModal).
  // 검증실패(422 등)는 **detail 을 throw** — searchBestSignMask 가 잡아 사용자에게 구체 사유 표시.
  // (이전엔 null 만 반환해 "캘리브레이션 실패" 일반 메시지만 떠 사용자가 원인[공선 등]을 몰랐음.)
  async function handleCalibSave(payload: CalibrationUpdate): Promise<CalibrationState | null> {
    const resp = await fetch(`${apiBase()}/api/ipcams/${cam.stream_key}/calibration`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      // FastAPI 검증오류: {detail:[{msg,...}]} 또는 {detail:"..."}. 첫 msg 를 사람이 읽을 사유로.
      const body = await resp.json().catch(() => null);
      const detail = Array.isArray(body?.detail)
        ? body.detail.map((e: { msg?: string }) => e.msg).filter(Boolean).join("; ")
        : typeof body?.detail === "string"
          ? body.detail
          : `HTTP ${resp.status}`;
      throw new Error(detail);
    }
    return (await resp.json()) as CalibrationState;
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-title calibration-title">
          <svg
            className="ico ico-lg calibration-mark"
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
          <h1>기준점 설정</h1>
          <span className="hint">CAM-{String(cam.id).padStart(2, "0")} · {cam.name}</span>
        </div>
        <div className="topbar-right">
          <button className="btn" onClick={onBack}>← 카메라 목록</button>
        </div>
      </header>

      <div className="content calibration-content">
        <section className="panel pad calib-page">
          <div className="calib-toolbar row-between">
            <div>
              <strong>라이브 프리뷰</strong>
              <p className="hint">현재 프레임을 캡처한 뒤 기준점을 배치합니다.</p>
            </div>
            <button className="btn icon-btn" onClick={regrabSnapshot}>
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
                <path d="M20 11.5A8 8 0 0 0 6.2 6.6L4 9" />
                <path d="M4 4.5V9h4.5" />
                <path d="M4 12.5a8 8 0 0 0 13.8 4.9L20 15" />
                <path d="M20 19.5V15h-4.5" />
              </svg>
              현재 프레임으로 갱신
            </button>
          </div>

          {/* WHEP <video> 를 페이지에 항상 마운트(디코딩 유지 → 실 프레임 grab). 화면엔 작게 보이는
              라이브 프리뷰로 두고, 큰 picking 영역은 grab 한 스냅샷(CalibrationModal inline). */}
          <div className="calib-live-preview">
            <WhepPlayer ref={videoRef} streamKey={cam.stream_key} />
          </div>

          {savedMsg && <p className="calib-result">{savedMsg}</p>}

          <CalibrationModal
            open
            inline
            onClose={onBack}
            cameraName={cam.name}
            snapshotUrl={snapshot}
            initialState={initialState}
            onSave={handleCalibSave}
            onSaved={() => setSavedMsg("저장되었습니다. 기준점이 적용되었습니다.")}
          />
        </section>
      </div>
    </>
  );
}
