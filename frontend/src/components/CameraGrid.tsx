import { useState, useEffect, useCallback, useRef } from "react";
import type { Cam } from "../pages/CamerasPage";
import type { AutoMeasurement } from "../types/detection";
import { apiBase } from "../hooks/useApi";
import { useDetectionWs } from "../hooks/useDetectionWs";
import { measurableHomography } from "../utils/calibrationGate";
import DetectionDistanceOverlay from "./DetectionDistanceOverlay";
import WhepPlayer from "./WhepPlayer";
import MeasureFocusModal from "./MeasureFocusModal";

type Calib = {
  homography: number[][] | null;
  enabled: boolean;
  k1: number;
  nativeSize: [number, number] | null;
};

// 사용자 오버라이드(게이트2) — 1줄 최대 4칸, 4 채워지면 다음 줄로 wrap.
function getGridColumns(count: number): number {
  return Math.min(Math.max(count, 1), 4);
}

interface Props {
  cams: Cam[];
  onFps?: (streamKey: string, fps: number) => void;
  autoMeasurements?: Record<string, AutoMeasurement>;
}

// 셀 = WhepPlayer(WebRTC) + 거리측정 토글(calibration 완료 카메라만 enable).
function GridCell({
  cam,
  onFps,
  homography,
  k1,
  nativeSize,
  autoMeasurement,
  onMeasure,
}: {
  cam: Cam;
  onFps?: (streamKey: string, fps: number) => void;
  homography: number[][] | null;
  k1: number;
  nativeSize: [number, number] | null;
  autoMeasurement: AutoMeasurement | undefined;
  onMeasure: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const calibrated = homography != null;
  const autoActive = Boolean(
    calibrated &&
      autoMeasurement?.enabled &&
      autoMeasurement.classes.length >= 1 &&
      autoMeasurement.classes.length <= 2,
  );
  const detection = useDetectionWs(cam.stream_key, autoActive);

  return (
    <div className="grid-cell">
      <WhepPlayer
        ref={videoRef}
        streamKey={cam.stream_key}
        onFps={(fps) => onFps?.(cam.stream_key, fps)}
      />
      {autoActive && homography && autoMeasurement && (
        <DetectionDistanceOverlay
          videoRef={videoRef}
          detections={detection.items}
          frameW={detection.frameW}
          frameH={detection.frameH}
          selectedClasses={autoMeasurement.classes}
          homography={homography}
          k1={k1}
          nativeSize={nativeSize}
        />
      )}
      {/* 거리측정 토글 — calibration 없으면 disabled. ON 시 focus 확대 모달. */}
      <button
        className={autoActive ? "grid-measure-toggle armed" : "grid-measure-toggle"}
        disabled={!calibrated}
        title={calibrated ? "거리 측정 모드 (확대)" : "calibration 먼저 설정하세요"}
        onClick={onMeasure}
      >
        테스트
      </button>
      <div className="cam-cell-bar">
        <span className="cam-cell-channel">
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
            <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1.1-1.7A1 1 0 0 1 9.1 4h5.8a1 1 0 0 1 .8.4L16.8 6h1.7A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
            <circle cx="12" cy="12.5" r="3.2" />
          </svg>
          CAM
        </span>
        <span className="cam-cell-name">{cam.name}</span>
        <span className="cam-cell-id">CAM-{String(cam.id).padStart(2, "0")}</span>
      </div>
    </div>
  );
}

export default function CameraGrid({ cams, onFps, autoMeasurements = {} }: Props) {
  // 카메라별 calibration — GET. homography + enabled(측정 표시 on/off gate). null=미설정.
  const [calibs, setCalibs] = useState<Record<string, Calib>>({});
  // 거리측정 focus 대상 카메라(null=닫힘).
  const [focusCam, setFocusCam] = useState<Cam | null>(null);

  // 각 카메라 calibration 1회 로딩 — homography + enabled 로 측정 gate(finding #4).
  const loadCalibrations = useCallback(async () => {
    const entries = await Promise.all(
      cams.map(async (c) => {
        try {
          const resp = await fetch(`${apiBase()}/api/ipcams/${c.stream_key}/calibration`);
          if (!resp.ok) {
            return [
              c.stream_key,
              { homography: null, enabled: false, k1: 0, nativeSize: null },
            ] as const;
          }
          const state = await resp.json();
          const calib: Calib = {
            homography: (state.homography as number[][] | null) ?? null,
            enabled: state.enabled ?? false,
            k1: state.k1 ?? 0,
            nativeSize: (state.native_size as [number, number] | null) ?? null,
          };
          return [c.stream_key, calib] as const;
        } catch {
          return [
            c.stream_key,
            { homography: null, enabled: false, k1: 0, nativeSize: null },
          ] as const;
        }
      }),
    );
    setCalibs(Object.fromEntries(entries));
  }, [cams]);

  useEffect(() => {
    loadCalibrations();
  }, [loadCalibrations]);

  if (cams.length === 0) {
    return <p className="grid-empty">등록된 카메라가 없습니다.</p>;
  }

  const columns = getGridColumns(cams.length);
  const focusCalib = focusCam ? calibs[focusCam.stream_key] : null;
  // enabled=false 면 homography 가 있어도 측정 불가 — measurableHomography 로 gate(finding #4).
  const focusH = focusCalib
    ? measurableHomography(focusCalib.enabled, focusCalib.homography)
    : null;

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {cams.map((cam) => {
          const calib = calibs[cam.stream_key];
          return (
            <GridCell
              key={`${cam.id}:${cam.rtsp_url}`}
              cam={cam}
              onFps={onFps}
              homography={calib ? measurableHomography(calib.enabled, calib.homography) : null}
              k1={calib?.k1 ?? 0}
              nativeSize={calib?.nativeSize ?? null}
              autoMeasurement={autoMeasurements[cam.stream_key]}
              onMeasure={() => setFocusCam(cam)}
            />
          );
        })}
      </div>

      {/* focus 확대 모달 — calibration 완료(H 있음) + enabled 카메라만 열림. */}
      {focusCam && focusH && (
        <MeasureFocusModal
          cam={focusCam}
          homography={focusH}
          k1={focusCalib?.k1 ?? 0}
          onClose={() => setFocusCam(null)}
        />
      )}
    </>
  );
}
