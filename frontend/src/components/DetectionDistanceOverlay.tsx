import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Detection, SelectedYoloClass } from "../types/detection";
import {
  buildDetectionPairs,
  filterDetectionsByClassConfidence,
  modelClassKey,
} from "../utils/detectionPairs";
import { pixelToWorld } from "../utils/pixelToWorld";

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  detections: Detection[];
  frameW: number;
  frameH: number;
  selectedClasses: SelectedYoloClass[];
  homography: number[][];
  k1: number;
  nativeSize: readonly [number, number] | null;
}

const BOX_COLORS = ["#2ec4d6", "#f08a24"];

export default function DetectionDistanceOverlay({
  videoRef,
  detections,
  frameW,
  frameH,
  selectedClasses,
  homography,
  k1,
  nativeSize,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const update = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setSize((current) =>
          current?.w === video.videoWidth && current.h === video.videoHeight
            ? current
            : { w: video.videoWidth, h: video.videoHeight },
        );
      }
    };
    video.addEventListener("loadedmetadata", update);
    video.addEventListener("resize", update);
    update();
    return () => {
      video.removeEventListener("loadedmetadata", update);
      video.removeEventListener("resize", update);
    };
  }, [videoRef]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const selectedClassKeys = selectedClasses.map((item) => modelClassKey(item.model, item.id));
    const visible = filterDetectionsByClassConfidence(detections, selectedClasses);
    if (visible.length === 0) return;

    const sx = frameW > 0 ? size.w / frameW : 1;
    const sy = frameH > 0 ? size.h / frameH : 1;
    const scale = Math.max(1, Math.min(size.w, size.h) / 600);
    const fontPx = Math.max(12, Math.round(13 * scale));
    ctx.font = `600 ${fontPx}px sans-serif`;
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";

    const footpoint = (det: Detection): [number, number] => [
      ((det.xyxy[0] + det.xyxy[2]) / 2) * sx,
      det.xyxy[3] * sy,
    ];

    const pixelPoints = new Map<Detection, [number, number]>();
    const worldPoints = new Map<Detection, [number, number] | null>();
    for (const det of visible) {
      const point = footpoint(det);
      pixelPoints.set(det, point);
      worldPoints.set(det, pixelToWorld(homography, point[0], point[1], k1, nativeSize));
    }

    const worldDistance = (from: Detection, to: Detection): number | null => {
      const w1 = worldPoints.get(from);
      const w2 = worldPoints.get(to);
      if (!w1 || !w2) return null;
      const metres = Math.hypot(w2[0] - w1[0], w2[1] - w1[1]);
      return Number.isFinite(metres) ? metres : null;
    };

    // 거리선을 먼저 그려 bbox와 클래스 라벨이 항상 위에 남도록 한다.
    for (const [from, to] of buildDetectionPairs(visible, selectedClasses, worldDistance)) {
      const p1 = pixelPoints.get(from);
      const p2 = pixelPoints.get(to);
      const w1 = worldPoints.get(from);
      const w2 = worldPoints.get(to);
      if (!p1 || !p2) continue;
      if (!w1 || !w2) continue;
      const metres = Math.hypot(w2[0] - w1[0], w2[1] - w1[1]);
      if (!Number.isFinite(metres)) continue;

      ctx.strokeStyle = "#f2c31d";
      ctx.lineWidth = Math.max(2, 2.5 * scale);
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.stroke();

      for (const point of [p1, p2]) {
        ctx.fillStyle = "#f2c31d";
        ctx.beginPath();
        ctx.arc(point[0], point[1], Math.max(3, 3.5 * scale), 0, Math.PI * 2);
        ctx.fill();
      }

      const label = `${metres.toFixed(2)} m`;
      const padX = 5 * scale;
      const padY = 3 * scale;
      const labelW = ctx.measureText(label).width + padX * 2;
      const labelH = fontPx + padY * 2;
      const midX = (p1[0] + p2[0]) / 2;
      const midY = (p1[1] + p2[1]) / 2;
      ctx.fillStyle = "rgba(14, 17, 19, .88)";
      ctx.fillRect(midX - labelW / 2, midY - labelH / 2, labelW, labelH);
      ctx.fillStyle = "#f2c31d";
      ctx.fillText(label, midX - labelW / 2 + padX, midY - labelH / 2 + padY);
    }

    for (const det of visible) {
      const [x1, y1, x2, y2] = [
        det.xyxy[0] * sx,
        det.xyxy[1] * sy,
        det.xyxy[2] * sx,
        det.xyxy[3] * sy,
      ];
      const colorIndex = Math.max(
        0,
        selectedClassKeys.indexOf(modelClassKey(det.model, det.class_id)),
      );
      const color = BOX_COLORS[colorIndex] ?? BOX_COLORS[0];
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, 2 * scale);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      const label = `${det.name} ${det.conf.toFixed(2)}`;
      const pad = 4 * scale;
      const labelW = ctx.measureText(label).width + pad * 2;
      const labelH = fontPx + pad;
      const labelY = Math.max(0, y1 - labelH);
      ctx.fillStyle = color;
      ctx.fillRect(x1, labelY, labelW, labelH);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x1 + pad, labelY + pad / 2);
    }
  }, [detections, frameH, frameW, homography, k1, nativeSize, selectedClasses, size]);

  if (!size) return null;
  return <canvas ref={canvasRef} width={size.w} height={size.h} className="detection-distance-overlay" />;
}
