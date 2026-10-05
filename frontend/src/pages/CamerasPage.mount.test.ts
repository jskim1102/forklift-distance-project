import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectCallback } from "react";
import CamerasPage, { MEASURE_STORAGE_KEY } from "./CamerasPage";

// DOM 없이 mount의 실제 fetch/상태 반영을 검증한다. updater는 실행하지 않아
// 백엔드 동기화를 setState updater 실행 타이밍에 의존시키는 회귀도 잡는다.
const lifecycle = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  writes: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [
    typeof initial === "function" ? initial() : initial,
    (value: unknown) => lifecycle.writes.push(value),
  ],
  useEffect: (effect: EffectCallback) => lifecycle.effects.push(effect),
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
}));

vi.mock("../hooks/useApi", () => ({ apiBase: () => "" }));

const cleanups: Array<() => void> = [];
const anchor = { id: 0, name: "person", model: "anchor", conf: 0.5 };
const target = { id: 0, name: "forklift", model: "target", conf: 0.5 };

function mountWithTarget(classes: Array<{ id: number; name: string }> | null) {
  const measurements = { "ipcam-a": { enabled: true, classes: [anchor, target] } };
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => key === MEASURE_STORAGE_KEY ? JSON.stringify(measurements) : null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
  });
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "PUT") return Response.json({ enabled: false });
    switch (url) {
      case "/api/ipcams": return Response.json([]);
      case "/api/config": return Response.json({ max_ipcams: 16 });
      case "/api/inference/weights": return Response.json({ lanes: {
        anchor: { lane: "anchor", source: "preset", name: "yolo26x.pt" },
        target: classes == null ? null : { lane: "target", source: "upload", name: "best.pt" },
      } });
      case "/api/inference/lanes/anchor/classes": return Response.json([{ id: 0, name: "person" }]);
      case "/api/inference/lanes/target/classes": return Response.json(classes);
      default: throw new Error(`Unexpected request: ${url}`);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  CamerasPage({ onCalibrate: vi.fn() });
  for (const effect of lifecycle.effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return fetchMock;
}

beforeEach(() => {
  lifecycle.effects.length = 0;
  lifecycle.writes.length = 0;
  vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("페이지 진입 시 저장 선택 재검증", () => {
  it.each([
    ["클래스 이름 교체", [{ id: 0, name: "pallet" }]],
    ["상대 슬롯 제거", null],
  ] as const)("%s면 화면과 백엔드를 함께 끈다", async (_label, classes) => {
    const fetchMock = mountWithTarget(classes == null ? null : [...classes]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/ipcams/ipcam-a/inference",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: false }) }),
    ));
    expect(lifecycle.writes).toContainEqual({
      "ipcam-a": { enabled: false, classes: [anchor] },
    });
  });

  it("현재 클래스와 일치하는 선택은 유지하고 끄기 요청을 보내지 않는다", async () => {
    const fetchMock = mountWithTarget([{ id: 0, name: "forklift" }]);

    await vi.waitFor(() => expect(lifecycle.writes).toContainEqual({
      "ipcam-a": { enabled: true, classes: [anchor, target] },
    }));
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  });
});
