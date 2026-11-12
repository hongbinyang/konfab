import { describe, expect, it } from "vitest";
import {
  matchesPickerFilter,
  nextPickerIndex,
  pickerHint,
  pickerEmpty,
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

describe("role-picker guidance", () => {
  it("uses supplied library paths and names enabled sources", () => {
    const locations = {
      roles: "/custom/roles",
      skills: "/custom/skills",
      project: "/work/project/.konfab/skills",
      sources: ["example/skills", "other/plugins"],
    };
    expect(pickerHint("roles", locations)).toContain("/custom/roles");
    expect(pickerHint("roles", locations)).toContain("Built-in");
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
