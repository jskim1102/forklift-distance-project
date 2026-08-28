import type { ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  // 큰 모달(calibration)은 width 를 넓힘 — 기본은 substrate .modal 의 760px.
  maxWidth?: number;
  children: ReactNode;
}

// substrate .modal-overlay/.modal CSS 를 재사용하는 최소 모달 래퍼.
// CalibrationModal 이 import 하는 prime 의 `./Modal` 자리를 substrate 톤으로 채운다.
export default function Modal({ open, onClose, title, maxWidth, children }: Props) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={maxWidth ? { maxWidth } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title"><h2>{title}</h2></div>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
