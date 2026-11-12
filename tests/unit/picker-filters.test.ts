import { describe, expect, it } from "vitest";
import {
  matchesPickerFilter,
  nextPickerIndex,
  togglePickerFilter,
} from "../../web/src/picker-filters.js";

describe("role-picker filters", () => {
  it("combines choices as a union and restores All when the last is removed", () => {
    const both = togglePickerFilter(togglePickerFilter([], "roles"), "public");
    expect(both).toEqual(["roles", "public"]);
    expect(matchesPickerFilter(both, "roles")).toBe(true);
    expect(matchesPickerFilter(both, "public")).toBe(true);
    expect(matchesPickerFilter(both, "project")).toBe(false);
    expect(togglePickerFilter(both, "all")).toEqual([]);
    expect(togglePickerFilter(["public"], "public")).toEqual([]);
    expect(matchesPickerFilter([], "project")).toBe(true);
  });
  it("moves through visible results across group boundaries without wrapping", () => {
    expect(nextPickerIndex(1, "ArrowDown", 4)).toBe(2);
    expect(nextPickerIndex(2, "ArrowUp", 4)).toBe(1);
    expect(nextPickerIndex(0, "ArrowUp", 4)).toBeNull();
    expect(nextPickerIndex(3, "ArrowDown", 4)).toBeNull();
  });
});
