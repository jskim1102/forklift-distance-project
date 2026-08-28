import { useCallback, useEffect, useRef, useState } from "react";
import Modal from "../components/Modal";
import WhepPlayer from "../components/WhepPlayer";
import CalibrationModal, {
  type CalibrationState,
  type CalibrationUpdate,
} from "../components/CalibrationModal";
import MeasureOverlay from "../components/MeasureOverlay";
import { apiBase } from "../hooks/useApi";
import type { Cam } from "./CamerasPage";

interface Props {
  cam: Cam;
  onClose: () => void;
}

type Tab = "calibration" | "measure";

// 단일 카메라 측정 뷰 — CamerasPage 위 모달 1개. [calibration | 측정] 탭(calibration 기본).
// - calibration 탭: WHEP <video> 프레임 grab 한 still 에 점 picking(CalibrationModal inline 콘텐츠).
// - 측정 탭: 라이브 <video> + MeasureOverlay 2클릭 거리.
// WhepPlayer 는 양 탭 공유 — 항상 마운트(stage display 토글), 탭 전환 시 WHEP 재연결 안 함.
// calibration(img)·측정(video) 둘 다 videoClientToNatural 동일 보정 → 좌표 불변식 유지.
// 마운트=open(부모가 cam 선택 시에만 렌더) → 닫으면 unmount 로 WhepPlayer WebRTC 정리.
export default function MeasurePage({ cam, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [tab, setTab] = useState<Tab>("calibration"); // 진입 시 calibration 기본
  // live <video> 의 현재 프레임을 natural 해상도(videoWidth×videoHeight)로 grab 한
  // still dataURL. calibration 탭의 스냅샷 소스(prime /snapshot.jpg 대체).
  const [snapshot, setSnapshot] = useState<string | null>(null);
  // 저장된 homography(GET/PUT 결과) — MeasureOverlay 주입용.
  const [homography, setHomography] = useState<number[][] | null>(null);
  const [k1, setK1] = useState(0);
  const [calibEnabled, setCalibEnabled] = useState(false);
  // 모달 open 시 GET 으로 복원한 기존 calibration — CalibrationModal initialState.
  const [initialState, setInitialState] = useState<CalibrationState | null>(null);

  // 진입 시 저장된 calibration 복원 — 활성화돼 있으면 measure overlay 가 바로 측정 가능.
  const loadCalibration = useCallback(async () => {
    try {
      const resp = await fetch(`${apiBase()}/api/ipcams/${cam.stream_key}/calibration`);
      if (!resp.ok) return;
      const state: CalibrationState = await resp.json();
      setInitialState(state);
      setHomography(state.homography);
      setK1(state.k1 ?? 0);
      setCalibEnabled(state.enabled);
    } catch {
      // 백엔드/네트워크 오류 — 측정뷰는 calibration 없이도 로드(클릭만 비활성).
    }
  }, [cam.stream_key]);

  useEffect(() => {
    loadCalibration();
  }, [loadCalibration]);

  // <video> 현재 프레임 → canvas → dataURL. video 가 offscreen(display:block 유지)이라
  // 디코딩이 살아있어 실 프레임을 grab 한다(display:none 이면 throttle 돼 검게 나옴).
  const grabSnapshot = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
    return canvas.toDataURL("image/jpeg");
  }, []);

  // 스냅샷 자동 grab — **실제 디코딩된 프레임이 화면에 올라온 시점**에 잡는다(검은 화면 방지).
  // requestVideoFrameCallback 은 presented frame 마다 콜백 → 첫 호출 = 첫 실 프레임 보장.
  // 미지원 브라우저는 'loadeddata'+짧은 지연으로 폴백. 아직 스냅샷 없을 때만(탭 왕복 시 picking 유지).
  useEffect(() => {
    if (snapshot) return; // 이미 실 프레임 grab 함
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    const tryGrab = () => {
      if (cancelled) return;
      const still = grabSnapshot();
      if (still) setSnapshot(still);
    };

    type RVFCVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const v = video as RVFCVideo;
    if (typeof v.requestVideoFrameCallback === "function") {
      v.requestVideoFrameCallback(() => tryGrab()); // 첫 presented frame
      return () => {
        cancelled = true;
      };
    }
    // 폴백: 데이터 로드 후 한 프레임 여유 두고 grab + 도착 전이면 재시도.
    const onLoaded = () => window.setTimeout(tryGrab, 200);
    video.addEventListener("loadeddata", onLoaded);
    const id = window.setInterval(tryGrab, 500);
    const stop = window.setTimeout(() => window.clearInterval(id), 8000);
    return () => {
      cancelled = true;
      video.removeEventListener("loadeddata", onLoaded);
      window.clearInterval(id);
      window.clearTimeout(stop);
    };
  }, [snapshot, grabSnapshot]);

  // "현재 프레임으로 스냅샷 갱신" — 사용자가 원하면 최신 프레임 재grab(백업/수동).
  const regrabSnapshot = () => {
    const still = grabSnapshot();
    if (still) setSnapshot(still);
  };

  // 저장 — PUT /api/ipcams/{key}/calibration. 백엔드 cv2.findHomography 결과(CalibrationState)
  // 반환. CalibrationModal 의 sign-mask 전수탐색이 이 함수를 조합마다 호출 → best 채택.
  async function handleCalibSave(payload: CalibrationUpdate): Promise<CalibrationState | null> {
    try {
      const resp = await fetch(
        `${apiBase()}/api/ipcams/${cam.stream_key}/calibration`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!resp.ok) return null; // 검증실패(422)/없는키(404)/singular(400) → 이 조합 skip
      const state: CalibrationState = await resp.json();
      // best 조합이 모달에서 확정되면 이 state 가 마지막으로 저장된 값 — overlay 에 반영.
      setHomography(state.homography);
      setK1(state.k1 ?? 0);
      setCalibEnabled(state.enabled);
      return state;
    } catch {
      return null;
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`거리 측정 — CAM-${String(cam.id).padStart(2, "0")} · ${cam.name}`}
      maxWidth={980}
    >
      {/* 진입 즉시 calibration 화면(첫 화면). 측정 탭은 calibration 저장(H 확보) 전엔 잠김 —
          별도 "calibration 버튼" 단계 없이 바로 기준점 설정으로 들어간다. 저장되면 측정 자동전환.
          영상은 아래 stage 에서 persistent(탭 전환해도 WHEP 재연결 X). */}
      <div className="tabs" role="tablist">
        <button
          role="tab"
          className={tab === "calibration" ? "tab active" : "tab"}
          aria-selected={tab === "calibration"}
          onClick={() => setTab("calibration")}
        >
          1. 기준점 설정 (calibration)
        </button>
        <button
          role="tab"
          className={tab === "measure" ? "tab active" : "tab"}
          aria-selected={tab === "measure"}
          onClick={() => setTab("measure")}
          disabled={!homography}
          title={homography ? "" : "기준점 설정(calibration)을 먼저 저장하세요"}
        >
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
            <path d="M3 12h18" />
            <path d="m6 9-3 3 3 3" />
            <path d="m18 9 3 3-3 3" />
            <path d="M9 10.5v3M12 10.5v3M15 10.5v3" />
          </svg>
          2. 거리 측정
        </button>
      </div>

      {/* 라이브 영상 stage — 항상 마운트(WhepPlayer persistent). 측정 탭에선 보이고,
          calibration 탭에선 offscreen 으로 숨기되 **display:none 은 쓰지 않는다** —
          display:none 은 브라우저가 video 디코딩을 throttle 해 frame grab 이 검게 나오기 때문.
          offscreen(absolute, 화면 밖)은 렌더 트리에 남아 디코딩 유지 → 실 프레임 grab 보장.
          탭 복귀해도 video element 동일(재마운트/WHEP 재연결 없음). */}
      <div className={tab === "measure" ? "measure-stage" : "measure-stage measure-stage-offscreen"}>
        <WhepPlayer ref={videoRef} streamKey={cam.stream_key} />
        {tab === "measure" && (
          <MeasureOverlay
            videoRef={videoRef}
            homography={calibEnabled ? homography : null}
            k1={k1}
          />
        )}
      </div>

      {tab === "measure" && (
        <p className="hint">
          {calibEnabled
            ? "영상 위 두 점을 클릭해 실세계 거리(m)를 측정합니다 (다음 클릭 쌍은 새 측정)."
            : "calibration 탭에서 기준점을 먼저 설정하세요. 설정 후 두 점을 클릭하면 거리(m)가 표시됩니다."}
        </p>
      )}

      {/* calibration 탭 — CalibrationModal 의 inline 콘텐츠(자체 Modal 래퍼 없이 탭 패널).
          스냅샷 picking·삼각측량·저장(PUT)·H 복원 전부 동일. 새 스냅샷 버튼만 추가. */}
      {tab === "calibration" && (
        <div className="calib-tab">
          <div className="measure-actions">
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
              현재 프레임으로 스냅샷 갱신
            </button>
          </div>
          <CalibrationModal
            open
            inline
            onClose={onClose}
            cameraName={cam.name}
            snapshotUrl={snapshot}
            initialState={initialState}
            onSave={handleCalibSave}
            onSaved={() => setTab("measure")}
          />
        </div>
      )}

      <div className="modal-actions">
        <button onClick={onClose}>닫기</button>
      </div>
    </Modal>
  );
}
