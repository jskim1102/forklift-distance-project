import { describe, expect, it } from "vitest";

import { videoClientToNatural, containRect } from "./videoCoords";

// A minimal <video>-like stub: videoClientToNatural only reads videoWidth/videoHeight
// and getBoundingClientRect(). Plain object in node — no jsdom needed.
function makeVideo(
  videoWidth: number,
  videoHeight: number,
  rect: { left: number; top: number; width: number; height: number },
): HTMLVideoElement {
  return {
    videoWidth,
    videoHeight,
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
  } as unknown as HTMLVideoElement;
}

// An <img>-like stub. The same correction must apply, but natural dims come from
// naturalWidth/naturalHeight (an <img> has no videoWidth/videoHeight).
function makeImg(
  naturalWidth: number,
  naturalHeight: number,
  rect: { left: number; top: number; width: number; height: number },
): HTMLImageElement {
  return {
    naturalWidth,
    naturalHeight,
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
  } as unknown as HTMLImageElement;
}

describe("videoClientToNatural (object-fit: contain letterbox correction)", () => {
  it("maps a click in a pillarboxed (too-wide) element to natural px", () => {
    // natural 640x480 (4:3) into box 800x480 → scale 1.0, 80px bars left/right.
    const v = makeVideo(640, 480, { left: 0, top: 0, width: 800, height: 480 });
    expect(videoClientToNatural(v, 400, 240)).toEqual([320, 240]);
  });

  it("returns null for a click in a pillarbox bar", () => {
    const v = makeVideo(640, 480, { left: 0, top: 0, width: 800, height: 480 });
    expect(videoClientToNatural(v, 40, 240)).toBeNull(); // left bar (x<80)
  });

  it("maps a click in a letterboxed (too-tall) element to natural px", () => {
    // natural 640x480 into box 640x600 → scale 1.0, 60px bars top/bottom.
    const v = makeVideo(640, 480, { left: 0, top: 0, width: 640, height: 600 });
    expect(videoClientToNatural(v, 320, 300)).toEqual([320, 240]);
  });

  it("returns null for a click in a letterbox bar", () => {
    const v = makeVideo(640, 480, { left: 0, top: 0, width: 640, height: 600 });
    expect(videoClientToNatural(v, 320, 30)).toBeNull(); // top bar (y<60)
  });

  it("scales correctly when the element matches aspect ratio", () => {
    // natural 1280x720 into box 640x360 (same 16:9) → scale 0.5, no bars.
    const v = makeVideo(1280, 720, { left: 0, top: 0, width: 640, height: 360 });
    expect(videoClientToNatural(v, 320, 180)).toEqual([640, 360]);
  });

  it("accounts for the element's viewport offset (rect.left/top)", () => {
    // same as pillarbox but element offset by (100,50) in the viewport.
    const v = makeVideo(640, 480, { left: 100, top: 50, width: 800, height: 480 });
    // clientX/Y are viewport-relative: center of content = (100+80+320, 50+240) = (500,290)
    expect(videoClientToNatural(v, 500, 290)).toEqual([320, 240]);
  });

  it("returns null before the video has dimensions (videoWidth 0)", () => {
    const v = makeVideo(0, 0, { left: 0, top: 0, width: 800, height: 480 });
    expect(videoClientToNatural(v, 400, 240)).toBeNull();
  });
});

describe("videoClientToNatural with <img> (modal snapshot picking — same correction)", () => {
  it("maps an img click using naturalWidth/naturalHeight, identical to video", () => {
    // pillarbox: natural 640x480 into box 800x480 → scale 1.0, 80px bars.
    const img = makeImg(640, 480, { left: 0, top: 0, width: 800, height: 480 });
    expect(videoClientToNatural(img, 400, 240)).toEqual([320, 240]);
  });

  it("returns null for an img click in a letterbox bar", () => {
    const img = makeImg(640, 480, { left: 0, top: 0, width: 640, height: 600 });
    expect(videoClientToNatural(img, 320, 30)).toBeNull(); // top bar
  });

  it("produces bit-identical output for img and video with the same dims/rect", () => {
    // The core contract: modal img picking and measure video clicking must map
    // through the exact same correction, so calibration H applies correctly.
    const rect = { left: 12, top: 34, width: 800, height: 480 };
    const v = makeVideo(640, 480, rect);
    const img = makeImg(640, 480, rect);
    for (const [cx, cy] of [
      [400, 274],
      [200, 100],
      [700, 400],
    ]) {
      expect(videoClientToNatural(img, cx, cy)).toEqual(videoClientToNatural(v, cx, cy));
    }
  });

  it("returns null before the img has loaded (naturalWidth 0)", () => {
    const img = makeImg(0, 0, { left: 0, top: 0, width: 800, height: 480 });
    expect(videoClientToNatural(img, 400, 240)).toBeNull();
  });
});

describe("containRect (finding #3 — overlay/marker placement for non-16:9 streams)", () => {
  it("fills the container with no bars when aspect ratios match (16:9 in 16:9)", () => {
    expect(containRect(1600, 900, 1920, 1080)).toEqual({
      left: 0,
      top: 0,
      width: 1600,
      height: 900,
    });
  });

  it("pillarboxes a 4:3 stream inside a 16:9 wrapper", () => {
    // scale = min(1600/640, 900/480) = min(2.5, 1.875) = 1.875 → 1200×900, 200px side bars.
    expect(containRect(1600, 900, 640, 480)).toEqual({
      left: 200,
      top: 0,
      width: 1200,
      height: 900,
    });
  });

  it("pillarboxes a portrait stream inside a 16:9 wrapper", () => {
    // scale = min(1600/480, 900/640) = min(3.333, 1.406) = 1.40625 → 675×900.
    const r = containRect(1600, 900, 480, 640);
    expect(r.width).toBeCloseTo(675, 6);
    expect(r.height).toBeCloseTo(900, 6);
    expect(r.left).toBeCloseTo(462.5, 6);
    expect(r.top).toBeCloseTo(0, 6);
  });

  it("letterboxes a 16:9 stream inside a 4:3 wrapper", () => {
    // scale = min(800/1920, 600/1080) = 0.41666… → 800×450, 75px top/bottom bars.
    const r = containRect(800, 600, 1920, 1080);
    expect(r.width).toBeCloseTo(800, 6);
    expect(r.height).toBeCloseTo(450, 6);
    expect(r.left).toBeCloseTo(0, 6);
    expect(r.top).toBeCloseTo(75, 6);
  });

  // The key invariant: an overlay marker placed at a natural point (u,v) via containRect
  // must land at the SAME on-screen pixel that a click there maps back through
  // videoClientToNatural. This is what keeps yellow line / label / calibration markers
  // aligned with the video content on non-16:9 streams (finding #3).
  it.each([
    { label: "4:3 in 16:9 wrapper", natW: 640, natH: 480, boxW: 1600, boxH: 900 },
    { label: "portrait in 16:9 wrapper", natW: 480, natH: 640, boxW: 1600, boxH: 900 },
    { label: "16:9 in 4:3 wrapper", natW: 1920, natH: 1080, boxW: 800, boxH: 600 },
  ])("marker placement round-trips through click mapping ($label)", ({ natW, natH, boxW, boxH }) => {
    const rect = containRect(boxW, boxH, natW, natH);
    const el = makeVideo(natW, natH, { left: 0, top: 0, width: boxW, height: boxH });
    for (const [u, v] of [
      [0, 0],
      [natW / 2, natH / 2],
      [natW, natH],
      [natW * 0.3, natH * 0.8],
    ]) {
      // On-screen px where a marker for natural (u,v) is rendered inside the contain rect.
      const screenX = rect.left + (u / natW) * rect.width;
      const screenY = rect.top + (v / natH) * rect.height;
      // Feeding that pixel back through the click mapping must recover (u,v).
      const back = videoClientToNatural(el, screenX, screenY);
      expect(back).not.toBeNull();
      expect(back![0]).toBeCloseTo(u, 6);
      expect(back![1]).toBeCloseTo(v, 6);
    }
  });
});
