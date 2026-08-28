import { useEffect, useRef, useState } from "react";
import { videoClientToNatural, containRect } from "../utils/videoCoords";
import { pixelToWorld } from "../utils/pixelToWorld";

/**
 * WHEP `<video>` 위에 절대 위치 `<canvas>` 로 거리 측정 오버레이.
 *
 * BboxOverlay 패턴 유지:
 * - canvas internal width/height = video natural 픽셀 → 원본 좌표 그대로 그림
 * - CSS 가 canvas 와 video 를 똑같이 스케일 → 좌표 변환 코드 0
 * 입력 = 사용자 클릭 2점(videoClientToNatural→natural px) → pixelToWorld(H) 2점 →
 * euclidean(m) → 노란선 + "X.XX m" 라벨. 다음 2점 클릭 시 새 측정(reset).
 *
 * (strip: Detection interface·class filter/conf/settings·footpoint 이중루프·bbox render.)
 */

interface Props {
  // measure view 의 live <video> (MeasurePage forwardRef). 클릭 매핑·natural 크기 소스.
  videoRef: React.RefObject<HTMLVideoElement | null>;
  // 저장된 homography(픽셀→월드 m). null 이면 측정 비활성(클릭 무시).
  homography: number[][] | null;
  // 서버가 calibration 점으로 fit한 단일 radial 계수. legacy state는 0.
  k1?: number;
}

function MeasureOverlay({ videoRef, homography, k1 = 0 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // 무대(stage) 렌더 픽셀 크기 — canvas 를 video 의 object-fit:contain rect 에 정확히 겹치기 위함.
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  // 현재 측정의 클릭 점(natural px). 0개→1개→2개(완료) → 다음 클릭은 reset 후 1개.
  const [pts, setPts] = useState<[number, number][]>([]);

  // video natural 크기 — loadedmetadata 시 갱신(BboxOverlay onLoad 와 동형).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onMeta = () => {
      if (video.videoWidth && video.videoHeight) {
        setSize((prev) =>
          prev?.w === video.videoWidth && prev?.h === video.videoHeight
            ? prev
            : { w: video.videoWidth, h: video.videoHeight },
        );
      }
    };
    video.addEventListener("loadedmetadata", onMeta);
    if (video.videoWidth) onMeta();
    return () => video.removeEventListener("loadedmetadata", onMeta);
  }, [videoRef]);

  // 무대(canvas 부모, position:relative) 렌더 크기 관측 — resize/letterbox 변화에 따라 갱신.
  // canvas 는 size 준비 후에만 렌더되므로 [size] 후 parent 존재. ResizeObserver 로 반응형 유지.
  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setStage({ w: parent.clientWidth, h: parent.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [size]);

  // 그리기 — 2점 완료 시 노란선 + "X.XX m" 라벨, 1점은 점 마커.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (pts.length === 0) return;

    // 원본 좌표계 기준 적정 사이즈(BboxOverlay 와 동일 비율 보정).
    const scale = Math.max(1, Math.min(size.w, size.h) / 600);
    const fontPx = Math.max(11, Math.round(13 * scale));
    ctx.font = `${fontPx}px sans-serif`;
    ctx.textBaseline = "top";

    // 점 마커(둘 다)
    for (const [px, py] of pts) {
      ctx.fillStyle = "#f2c31d";
      ctx.beginPath();
      ctx.arc(px, py, Math.max(3, 4 * scale), 0, Math.PI * 2);
      ctx.fill();
    }

    if (pts.length < 2) return;

    const [a, b] = pts;
    // 노란선 (BboxOverlay L151-157)
    ctx.lineWidth = Math.max(1.5, 2.5 * scale);
    ctx.strokeStyle = "#f2c31d";
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();

    // 거리(m) — pixel→world 두 점 euclidean (BboxOverlay L140-142 의 euclidean).
    const nativeSize: [number, number] = [size.w, size.h];
    const wa = pixelToWorld(homography, a[0], a[1], k1, nativeSize);
    const wb = pixelToWorld(homography, b[0], b[1], k1, nativeSize);
    const txt =
      wa && wb
        ? `${Math.sqrt((wa[0] - wb[0]) ** 2 + (wa[1] - wb[1]) ** 2).toFixed(2)} m`
        : "—";

    // 중앙 라벨 — 노란 배경 / 검은 글자 (BboxOverlay L159-167)
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const padX = 5 * scale;
    const padY = 2 * scale;
    const labelH = fontPx + padY * 2;
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = "#f2c31d";
    ctx.fillRect(mx - tw / 2 - padX, my - labelH / 2, tw + padX * 2, labelH);
    ctx.fillStyle = "#000000";
    ctx.fillText(txt, mx - tw / 2, my - labelH / 2 + padY);
  }, [pts, size, homography, k1]);

  // 클릭 → natural px. 2점 완료 상태에서 클릭하면 새 측정(reset).
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!homography) return; // calibration 전엔 측정 불가
    const video = videoRef.current;
    if (!video) return;
    const nat = videoClientToNatural(video, e.clientX, e.clientY);
    if (!nat) return; // letterbox bar 클릭
    setPts((prev) => (prev.length >= 2 ? [nat] : [...prev, nat]));
  };

  if (!size) return null;

  // canvas 내부 해상도는 natural px 유지(그리기 좌표 불변). CSS box 는 video 의 contain rect
  // 로 지정 → 비-16:9 에서 letterbox/pillarbox 만큼 정확히 겹쳐 그린다(finding #3).
  // stage 측정 전엔 무대 전체로 폴백(첫 프레임 잠깐, aspect 동일하면 동일 결과).
  const rect = stage ? containRect(stage.w, stage.h, size.w, size.h) : null;
  const boxStyle: React.CSSProperties = rect
    ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : { left: 0, top: 0, width: "100%", height: "100%" };

  return (
    <canvas
      ref={canvasRef}
      width={size.w}
      height={size.h}
      className="measure-overlay"
      style={{ ...boxStyle, cursor: homography ? "crosshair" : "default" }}
      onClick={handleClick}
    />
  );
}

export default MeasureOverlay;
