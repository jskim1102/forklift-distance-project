import { useEffect, useRef, useState } from "react";
import type { Detection } from "../types/detection";
import { apiBase } from "./useApi";

const RECONNECT_DELAY_MS = 2000;

export interface DetectionStream {
  items: Detection[];
  frameW: number;
  frameH: number;
}

/** WHEP 영상과 별도로, 좌표만 보내는 카메라별 detection WebSocket을 구독한다. */
export function useDetectionWs(streamKey: string, active: boolean): DetectionStream {
  const [items, setItems] = useState<Detection[]>([]);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const reconnectTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      setItems([]);
      setFrame({ w: 0, h: 0 });
      return;
    }

    let stopped = false;
    let ws: WebSocket | null = null;
    const wsUrl = `${apiBase().replace(/^http/, "ws")}/api/ipcams/${streamKey}/ws`;

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event: MessageEvent) => {
        if (stopped || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as {
            type?: string;
            items?: Detection[];
            frame?: { w?: number; h?: number };
          };
          if (message.type !== "detections") return;
          setItems(message.items ?? []);
          setFrame({ w: message.frame?.w ?? 0, h: message.frame?.h ?? 0 });
        } catch {
          // 좌표 스트림의 손상된 단일 메시지는 다음 정상 프레임으로 복구한다.
        }
      };
      ws.onerror = () => ws?.close();
      ws.onclose = () => {
        if (!stopped) reconnectTimer.current = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      ws?.close();
      setItems([]);
    };
  }, [active, streamKey]);

  return { items, frameW: frame.w, frameH: frame.h };
}
