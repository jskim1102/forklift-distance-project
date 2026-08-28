import { describe, expect, it } from "vitest";

import { filterSelectableCustomClasses } from "./MeasurementClassModal";

describe("filterSelectableCustomClasses", () => {
  it("고정 기준 클래스인 person은 Custom 선택 목록에서 제외한다", () => {
    expect(
      filterSelectableCustomClasses([
        { id: 0, name: "person" },
        { id: 1, name: "forklift" },
        { id: 2, name: " Person " },
        { id: 3, name: "PERSON" },
        { id: 4, name: "pallet" },
      ]),
    ).toEqual([
      { id: 1, name: "forklift" },
      { id: 4, name: "pallet" },
    ]);
  });

  it("class id가 0이어도 이름이 person이 아니면 선택 대상으로 유지한다", () => {
    expect(filterSelectableCustomClasses([{ id: 0, name: "forklift" }])).toEqual([
      { id: 0, name: "forklift" },
    ]);
  });
});
