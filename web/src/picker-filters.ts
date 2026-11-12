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
