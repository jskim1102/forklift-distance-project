import { useRef } from "react";
import Modal from "./Modal";
import WhepPlayer from "./WhepPlayer";
import MeasureOverlay from "./MeasureOverlay";
import type { Cam } from "../pages/CamerasPage";

interface Props {
  cam: Cam;
  // 저장된 homography(픽셀→월드 m). 이 모달은 calibration 완료(H 있음) 카메라만 연다.
  homography: number[][];
  k1: number;
  onClose: () => void;
}

// 거리측정 focus(확대) 모달 — 그리드 셀 토글 ON 시 그 카메라를 큰 화면으로.
// 큰 라이브 <video>(WhepPlayer forwardRef) 위에 MeasureOverlay → 2점 정밀 클릭 → 거리(m).
// 마운트=open(부모가 focusCam 일 때만 렌더) → 닫으면 unmount 로 WhepPlayer WebRTC 정리.
export default function MeasureFocusModal({ cam, homography, k1, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  return (
    <Modal
      open
      onClose={onClose}
      title={`거리측정 — CAM-${String(cam.id).padStart(2, "0")} · ${cam.name}`}
      maxWidth={980}
    >
      {/* 큰 무대 — 라이브 video + MeasureOverlay(2클릭 거리). 정밀 클릭용 확대. */}
      <div className="measure-stage">
        <WhepPlayer ref={videoRef} streamKey={cam.stream_key} />
        {/* 클릭 = videoClientToNatural(video) → pixelToWorld(H) → euclidean(m).
            calibration picking 과 동일 natural-px 좌표계 → 거리 정확. */}
        <MeasureOverlay videoRef={videoRef} homography={homography} k1={k1} />
      </div>

      <p className="hint">
        영상 위 두 점을 클릭해 실세계 거리(m)를 측정합니다. 다음 두 점을 클릭하면 새 측정입니다.
      </p>

      <div className="modal-actions">
        <button onClick={onClose}>닫기</button>
      </div>
    </Modal>
  );
}
