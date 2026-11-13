import { describe, expect, it } from "vitest";
import {
  matchesPickerFilter,
  nextPickerIndex,
  pickerHint,
  pickerEmpty,
  togglePickerFilter,
} from "../../web/src/picker-filters.js";

describe("skill picker filters", () => {
  it("combines choices as a union and restores All when the last is removed", () => {
    const both = togglePickerFilter(
      togglePickerFilter([], "builtin"),
      "public",
    );
    expect(both).toEqual(["builtin", "public"]);
    expect(matchesPickerFilter(both, "builtin")).toBe(true);
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

describe("skill picker guidance", () => {
  it("uses supplied library paths and names enabled sources", () => {
    const locations = {
      skills: "/custom/skills",
      project: "/work/project/.konfab/skills",
      sources: ["example/skills", "other/plugins"],
    };
    expect(pickerHint("builtin", locations)).toContain("ship with Konfab");
    expect(pickerHint("personal", locations)).toContain("/custom/skills");
    expect(pickerHint("project", locations)).toContain(
      "/work/project/.konfab/skills",
    );
    expect(pickerHint("public", locations)).toContain(
      "example/skills, other/plugins",
    );
    expect(pickerHint("project", { ...locations, project: null })).toContain(
      "Set a project folder",
    );
  });
  it("distinguishes empty categories from a search with no matches", () => {
    expect(pickerEmpty("personal", "", false)).toContain("No personal skills");
    expect(pickerEmpty("project", "", false)).toContain("Set a project folder");
    expect(pickerEmpty("project", "", true)).toContain("No project skills");
    expect(pickerEmpty("public", "report", true)).toBe(
      "No matches for “report”.",
    );
  });
});
