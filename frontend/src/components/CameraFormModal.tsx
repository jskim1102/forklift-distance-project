import { useState, useEffect } from "react";
import type { Cam } from "../pages/CamerasPage";

interface Props {
  open: boolean;
  editCam: Cam | null;
  onClose: () => void;
  onSave: (name: string, rtspUrl: string) => Promise<string | null>;
}

export default function CameraFormModal({ open, editCam, onClose, onSave }: Props) {
  const [name, setName] = useState("");
  const [rtspUrl, setRtspUrl] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(editCam?.name ?? "");
      setRtspUrl(editCam?.rtsp_url ?? "");
      setError("");
      setSubmitting(false);
    }
  }, [open, editCam]);

  if (!open) return null;

  // onSave 는 부모(CamerasPage)에서 POST/PUT /api/ipcams 로 처리한다(성공=null, 실패=메시지).
  // register 시 백엔드가 ffprobe 로 코덱감지(수 초)하므로, await 동안 버튼을 '등록 중…'+disable 로
  // 잠가 진행 중임을 보인다. 성공 시 닫고, 실패 시 메시지 표시 + 열린 채 유지(재시도).
  async function handleSubmit() {
    if (!name.trim() || !rtspUrl.trim()) {
      setError("이름과 RTSP URL을 입력하세요.");
      return;
    }
    setSubmitting(true);
    const err = await onSave(name.trim(), rtspUrl.trim());
    setSubmitting(false);
    if (err) setError(err);
    else onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <h2>{editCam ? "카메라 수정" : "카메라 등록"}</h2>
            <p className="hint">카메라 이름과 RTSP 연결 주소를 입력하세요.</p>
          </div>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>카메라 이름</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 정문 입구 카메라"
            />
          </div>

          <div className="field">
            <label>RTSP URL</label>
            <input
              value={rtspUrl}
              onChange={(e) => setRtspUrl(e.target.value)}
              placeholder="rtsp://192.168.0.100:554/stream1"
            />
            <p className="hint">
              형식 — rtsp://[user:pass@]IP:PORT/PATH · 지원 코덱 H.264 / H.265
            </p>
            {editCam && rtspUrl.includes(":***@") && (
              <p className="hint">
                ⚠️ <code>***</code> = 기존 비밀번호 유지. 주소·포트·경로는 그대로 수정하면 반영됩니다.
                비밀번호를 변경하려면 <code>***</code> 를 지우고 새 비밀번호를 입력하세요.
              </p>
            )}
          </div>

          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={submitting}>취소</button>
          <button className="btn primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? (editCam ? "저장 중…" : "등록 중…") : editCam ? "저장" : "등록"}
          </button>
        </div>
      </div>
    </div>
  );
}
