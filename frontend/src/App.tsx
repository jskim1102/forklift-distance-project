import { useState } from "react";
import CamerasPage, { type Cam } from "./pages/CamerasPage";
import CalibrationPage from "./pages/CalibrationPage";
import MeasurePage from "./pages/MeasurePage";

// 단순 데모 — 라우터 없이 view-state 전환(카메라 목록 ↔ calibration 풀페이지 ↔ 측정 뷰).
// calibration 버튼 → 큰 화면에서 기준점 picking. 측정 버튼 → 단일 카메라 측정 뷰(F5).
type View =
  | { name: "cameras" }
  | { name: "calibration"; cam: Cam }
  | { name: "measure"; cam: Cam };

export default function App() {
  const [view, setView] = useState<View>({ name: "cameras" });

  const content = view.name === "calibration"
    ? <CalibrationPage cam={view.cam} onBack={() => setView({ name: "cameras" })} />
    : view.name === "measure"
      ? <MeasurePage cam={view.cam} onClose={() => setView({ name: "cameras" })} />
      : (
        <CamerasPage
          onCalibrate={(cam) => setView({ name: "calibration", cam })}
        />
      );

  return <main className="main">{content}</main>;
}
