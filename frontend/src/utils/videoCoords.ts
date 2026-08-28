// Map a viewport click on a WHEP <video> OR a snapshot <img> (both rendered with
// object-fit: contain) to a natural-pixel [u, v] coordinate, or null if the click
// landed on a letterbox bar.
//
// Both element types go through the IDENTICAL contain-fit correction so that modal
// snapshot picking (<img>) and live measure clicking (<video>) share one coordinate
// system — calibration H fit on the snapshot then applies correctly to measure clicks.
// The only difference is where natural dimensions come from: <video> has
// videoWidth/videoHeight, <img> has naturalWidth/naturalHeight.
//
// prime CalibrationModal L185-194 scaled <img> clicks with naturalW/rect.width — a
// straight stretch that assumes the media fills its box. Our substrate .grid-cell-video
// uses object-fit: contain (styles.css), so the media is fit (not stretched), leaving
// letterbox/pillarbox bars. We reconstruct the rendered content rect from the media's
// aspect ratio, map only clicks inside it, and reject bar clicks.

// 요소 타입에서 natural 해상도를 뽑는다 — img=naturalWidth/Height, video=videoWidth/Height.
// duck-typing(프로퍼티 존재)으로 구분 — instanceof 는 DOM 글로벌 없는 환경(node 테스트)에서 불가.
function naturalSize(el: HTMLVideoElement | HTMLImageElement): [number, number] {
  if ("naturalWidth" in el) {
    return [el.naturalWidth, el.naturalHeight];
  }
  return [el.videoWidth, el.videoHeight];
}

export function videoClientToNatural(
  el: HTMLVideoElement | HTMLImageElement,
  clientX: number,
  clientY: number,
): [number, number] | null {
  const [natW, natH] = naturalSize(el);
  if (natW <= 0 || natH <= 0) return null; // 아직 미디어 메타데이터 없음(프레임/이미지 도착 전)

  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  // object-fit: contain → 양축 중 더 빡빡한 쪽에 맞춘다(가장 작은 scale).
  const scale = Math.min(rect.width / natW, rect.height / natH);
  const renderedW = natW * scale;
  const renderedH = natH * scale;

  // letterbox/pillarbox bar 두께 — 남는 공간을 양쪽에 반씩.
  const offsetX = (rect.width - renderedW) / 2;
  const offsetY = (rect.height - renderedH) / 2;

  // 클릭을 콘텐츠 rect 기준 좌표로(뷰포트 → element → content).
  const localX = clientX - rect.left - offsetX;
  const localY = clientY - rect.top - offsetY;

  // bar 영역(콘텐츠 밖) 클릭은 매핑 불가.
  if (localX < 0 || localY < 0 || localX > renderedW || localY > renderedH) {
    return null;
  }

  return [localX / scale, localY / scale];
}

// Forward of videoClientToNatural: given the element's rendered box (containerW×containerH)
// and the media's natural size, return the object-fit: contain content rect (letterbox
// geometry) as {left, top, width, height} in the element's local px. Overlays (measure
// canvas, calibration markers) must be placed INSIDE this rect so they line up with the
// contained media on non-16:9 streams — the exact letterbox/pillarbox offset the click
// mapping above already compensates for. Placing them over the raw wrapper stretches them
// into the bars (finding #3).
export interface ContainRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function containRect(
  containerW: number,
  containerH: number,
  naturalW: number,
  naturalH: number,
): ContainRect {
  // 미디어/컨테이너 크기 미확정이면 컨테이너 전체를 반환(측정 불가 상태의 안전한 기본).
  if (naturalW <= 0 || naturalH <= 0 || containerW <= 0 || containerH <= 0) {
    return { left: 0, top: 0, width: containerW, height: containerH };
  }
  const scale = Math.min(containerW / naturalW, containerH / naturalH);
  const width = naturalW * scale;
  const height = naturalH * scale;
  return {
    left: (containerW - width) / 2,
    top: (containerH - height) / 2,
    width,
    height,
  };
}
