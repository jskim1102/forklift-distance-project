import { describe, expect, it } from "vitest";
import { loadStoredMeasurements, MEASURE_STORAGE_KEY } from "./CamerasPage";

const V1_KEY = "forklift-distance:auto-measure:v1";

function storage(entries: Record<string, string>) {
  const removed: string[] = [];
  return {
    removed,
    getItem: (key: string) => (key in entries ? entries[key] : null),
    removeItem: (key: string) => {
      removed.push(key);
      delete entries[key];
    },
  };
}

function stored(value: unknown) {
  return storage({ [MEASURE_STORAGE_KEY]: JSON.stringify(value) });
}

describe("loadStoredMeasurements", () => {
  it("v2 키만 읽고 v1 데이터는 폐기한다", () => {
    const store = storage({
      [V1_KEY]: JSON.stringify({
        "ipcam-a": {
          enabled: true,
          classes: [
            { id: 0, name: "person", model: "yolo26x.pt", conf: 0.5 },
            { id: 0, name: "forklift", model: "warehouse.pt", conf: 0.5 },
          ],
        },
      }),
    });

    expect(loadStoredMeasurements(store)).toEqual({});
    expect(store.removed).toContain(V1_KEY);
  });

  it("레인 id 가 아닌 model 값은 폐기한다", () => {
    const store = stored({
      "ipcam-a": {
        enabled: true,
        classes: [
          { id: 0, name: "person", model: "yolo26x.pt", conf: 0.5 },
          { id: 0, name: "forklift", model: "target", conf: 0.5 },
        ],
      },
    });

    expect(loadStoredMeasurements(store)).toEqual({});
  });

  it("anchor·target 각각 1개인 선택만 복원하고 enabled 를 유지한다", () => {
    const store = stored({
      "ipcam-a": {
        enabled: true,
        classes: [
          { id: 0, name: "person", model: "anchor", conf: 0.7 },
          { id: 3, name: "forklift", model: "target", conf: 0.35 },
        ],
      },
      "ipcam-b": {
        enabled: false,
        classes: [
          { id: 0, name: "person", model: "anchor", conf: 0.5 },
          { id: 1, name: "pallet", model: "target", conf: 0.5 },
        ],
      },
    });

    expect(loadStoredMeasurements(store)).toEqual({
      "ipcam-a": {
        enabled: true,
        classes: [
          { id: 0, name: "person", model: "anchor", conf: 0.7 },
          { id: 3, name: "forklift", model: "target", conf: 0.35 },
        ],
      },
      "ipcam-b": {
        enabled: false,
        classes: [
          { id: 0, name: "person", model: "anchor", conf: 0.5 },
          { id: 1, name: "pallet", model: "target", conf: 0.5 },
        ],
      },
    });
  });

  it("한쪽 레인만 있는 선택은 폐기한다", () => {
    const store = stored({
      "ipcam-a": {
        enabled: true,
        classes: [
          { id: 0, name: "person", model: "anchor", conf: 0.5 },
          { id: 1, name: "car", model: "anchor", conf: 0.5 },
        ],
      },
    });

    expect(loadStoredMeasurements(store)).toEqual({});
  });

  it("중복 선택을 제거하고 2개 상한을 적용한다", () => {
    const store = stored({
      "ipcam-a": {
        enabled: true,
        classes: [
          { id: 0, name: "person", model: "anchor", conf: 0.5 },
          { id: 0, name: "person", model: "anchor", conf: 0.9 },
          { id: 3, name: "forklift", model: "target", conf: 0.4 },
          { id: 4, name: "pallet", model: "target", conf: 0.4 },
        ],
      },
    });

    expect(loadStoredMeasurements(store)["ipcam-a"].classes).toEqual([
      { id: 0, name: "person", model: "anchor", conf: 0.5 },
      { id: 3, name: "forklift", model: "target", conf: 0.4 },
    ]);
  });

  it("깨진 JSON 은 빈 상태로 떨어진다", () => {
    expect(loadStoredMeasurements(storage({ [MEASURE_STORAGE_KEY]: "{" }))).toEqual({});
    expect(loadStoredMeasurements(storage({}))).toEqual({});
  });
});
