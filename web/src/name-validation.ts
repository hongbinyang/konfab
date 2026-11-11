export const nameRule =
  "Use 1–64 lowercase letters or numbers, separated by single hyphens; no spaces or leading, trailing, or consecutive hyphens.";

export function validName(name: string): boolean {
  return (
    [...name].length <= 64 &&
    name === name.toLowerCase() &&
    /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name)
  );
}

export function suggestName(value: string): string {
  return [
    ...value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
  ]
    .slice(0, 64)
    .join("")
    .replace(/-+$/g, "");
}
