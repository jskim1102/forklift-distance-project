import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import CamerasPage, { MEASURE_STORAGE_KEY } from "./CamerasPage";
import CameraGrid from "../components/CameraGrid";

// DOM 없이 mount의 실제 fetch/상태 반영을 검증한다. updater는 실행하지 않아
// 백엔드 동기화를 setState updater 실행 타이밍에 의존시키는 회귀도 잡는다.
const lifecycle = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  writes: [] as unknown[],
  states: [] as unknown[],
  stateIndex: 0,
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = lifecycle.stateIndex++;
    if (index >= lifecycle.states.length) {
      lifecycle.states.push(typeof initial === "function" ? initial() : initial);
    }
    return [lifecycle.states[index], (value: unknown) => {
      lifecycle.writes.push(value);
      if (typeof value !== "function") lifecycle.states[index] = value;
    }];
  },
  useEffect: (effect: EffectCallback) => lifecycle.effects.push(effect),
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
}));

vi.mock("../hooks/useApi", () => ({ apiBase: () => "" }));

const cleanups: Array<() => void> = [];
const anchor = { id: 0, name: "person", model: "anchor", conf: 0.5 };
const target = { id: 0, name: "forklift", model: "target", conf: 0.5 };

function renderPage() {
  lifecycle.stateIndex = 0;
  return CamerasPage({ onCalibrate: vi.fn() });
}

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

function renderedMeasurements() {
  return elements(renderPage()).find((node) => node.type === CameraGrid)?.props.autoMeasurements;
}

function renderedRestoreError() {
  return elements(renderPage()).find((node) => node.props.role === "alert")?.props.children;
}

function mountWithTarget(
  classes: Array<{ id: number; name: string }> | null,
  failure?: { url: string; remaining: number; network?: boolean },
) {
  const measurements = { "ipcam-a": { enabled: true, classes: [anchor, target] } };
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => key === MEASURE_STORAGE_KEY ? JSON.stringify(measurements) : null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
  });
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (failure?.url === url && failure.remaining-- > 0) {
      if (failure.network) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 503 });
    }
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
  renderPage();
  for (const effect of lifecycle.effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return fetchMock;
}

beforeEach(() => {
  lifecycle.effects.length = 0;
  lifecycle.writes.length = 0;
  lifecycle.states.length = 0;
  lifecycle.stateIndex = 0;
  vi.spyOn(globalThis, "setInterval").mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
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

  it.each([
    ["가중치 HTTP 오류", "/api/inference/weights", false],
    ["가중치 연결 오류", "/api/inference/weights", true],
    ["클래스 HTTP 오류", "/api/inference/lanes/target/classes", false],
  ])("%s 후 재시도하며 검증이 끝난 뒤에만 오버레이를 복구한다", async (_label, url, network) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = mountWithTarget([{ id: 0, name: "forklift" }], { url, remaining: 1, network });
    await vi.advanceTimersByTimeAsync(0);

    expect(renderedMeasurements()).toEqual({});
    expect(renderedRestoreError()).toContain("5초 후 다시 시도합니다.");
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
    await vi.advanceTimersByTimeAsync(4999);
    expect(renderedMeasurements()).toEqual({});
    await vi.advanceTimersByTimeAsync(1);

    expect(renderedMeasurements()).toEqual({ "ipcam-a": { enabled: true, classes: [anchor, target] } });
    expect(renderedRestoreError()).toBeUndefined();
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  });

  it("연속 실패 후 복구되면 바뀐 클래스 선택과 백엔드 자동측정을 함께 끈다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = mountWithTarget([{ id: 0, name: "pallet" }], {
      url: "/api/inference/weights", remaining: 2,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(renderedMeasurements()).toEqual({});
    expect(renderedRestoreError()).toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);

    expect(renderedMeasurements()).toEqual({ "ipcam-a": { enabled: false, classes: [anchor] } });
    expect(fetchMock).toHaveBeenCalledWith("/api/ipcams/ipcam-a/inference",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: false }) }));
    expect(renderedRestoreError()).toBeUndefined();
  });

  it("페이지를 떠나면 예약된 복구 요청을 취소한다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = mountWithTarget([{ id: 0, name: "forklift" }], {
      url: "/api/inference/weights", remaining: Infinity,
    });
    await vi.advanceTimersByTimeAsync(0);
    for (const cleanup of cleanups.splice(0)) cleanup();
    const calls = fetchMock.mock.calls.length;
    const writes = lifecycle.writes.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(lifecycle.writes).toHaveLength(writes);
  });
});
