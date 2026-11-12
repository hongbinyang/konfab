export type PickerFilter = "roles" | "personal" | "project" | "public";
export const pickerFilters: ReadonlyArray<{
  value: PickerFilter;
  label: string;
}> = [
  { value: "roles", label: "My roles" },
  { value: "personal", label: "My skills" },
  { value: "project", label: "Project" },
  { value: "public", label: "Public" },
];
export function togglePickerFilter(
  selected: readonly PickerFilter[],
  value: PickerFilter | "all",
): PickerFilter[] {
  if (value === "all") return [];
  return selected.includes(value)
    ? selected.filter((item) => item !== value)
    : [...selected, value];
}
export function matchesPickerFilter(
  selected: readonly PickerFilter[],
  value: PickerFilter,
): boolean {
  return selected.length === 0 || selected.includes(value);
}
export function nextPickerIndex(
  index: number,
  direction: "ArrowUp" | "ArrowDown",
  count: number,
): number | null {
  const next = index + (direction === "ArrowDown" ? 1 : -1);
  return index < 0 || next < 0 || next >= count ? null : next;
}
export type PickerLocations = {
  roles: string | null;
  skills: string | null;
  project: string | null;
  sources: string[];
};
export function pickerHint(
  filter: PickerFilter,
  locations: PickerLocations | null,
): string {
  if (!locations) return "Library locations unavailable.";
  if (filter === "roles")
    return locations.roles
      ? `Built-in roles and your personal roles · ${locations.roles}`
      : "Built-in roles and your personal roles";
  if (filter === "personal")
    return locations?.skills
      ? `Personal skills, available in any room · ${locations.skills}`
      : "Personal skills, available in any room";
  if (filter === "project")
    return locations?.project
      ? `Skills for this project · ${locations.project}`
      : "Set a project folder in the room's Edit to use project skills.";
  if (locations && locations.sources.length === 0)
    return "No GitHub sources enabled · Manage library → Public";
  return `GitHub sources${locations?.sources.length ? `: ${locations.sources.join(", ")}` : ""} · Manage library → Public`;
}
export function pickerEmpty(
  filter: PickerFilter,
  query: string,
  hasProject: boolean,
): string {
  if (query.trim()) return `No matches for “${query.trim()}”.`;
  if (filter === "roles") return "No roles available.";
  if (filter === "personal")
    return "No personal skills yet. Customize a public skill to save one.";
  if (filter === "project")
    return hasProject
      ? "No project skills yet. Customize a skill and choose This project."
      : "Set a project folder in the room's Edit to use project skills.";
  return "No public skills available. Check enabled sources and their status.";
}
