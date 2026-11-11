import { parseDocument } from "yaml";
import { SkillError } from "./skill-error.js";
import {
  invalidNameMessage,
  packageHash,
  validSkillName,
  type SkillFile,
} from "./skill-files.js";

export type RoleMetadata = {
  name: string;
  title: string;
  description: string;
};

export function roleMetadata(files: SkillFile[]): RoleMetadata {
  if (files.length > 100)
    throw new SkillError("role_limits", 413, "Role exceeds file limit");
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (
      !file.path ||
      file.path.startsWith("/") ||
      /[\\\0]/.test(file.path) ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      Buffer.byteLength(file.path) > 512 ||
      file.path.split("/").some((part) => part.startsWith(".konfab-")) ||
      seen.has(file.path)
    )
      throw new SkillError(
        "invalid_role",
        400,
        "Invalid or duplicate role path",
      );
    seen.add(file.path);
    total += file.content.length;
    if (
      file.content.length > 512 * 1024 ||
      total > 1024 * 1024 ||
      file.path.split("/").length > 16
    )
      throw new SkillError("role_limits", 413, "Role exceeds limits");
  }
  const manifest = files.find((file) => file.path === "ROLE.md");
  if (!manifest)
    throw new SkillError("invalid_role", 400, "ROLE.md is required");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(manifest.content);
  } catch {
    throw new SkillError("invalid_role", 400, "ROLE.md must be UTF-8");
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1])
    throw new SkillError("invalid_role", 400, "ROLE.md needs frontmatter");
  const document = parseDocument(match[1], {
    uniqueKeys: true,
    customTags: [],
  });
  if (document.errors.length)
    throw new SkillError("invalid_role", 400, "Invalid role frontmatter");
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new SkillError("invalid_role", 400, "Invalid role frontmatter");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SkillError("invalid_role", 400, "Invalid role frontmatter");
  const metadata = value as Record<string, unknown>;
  const name = typeof metadata.name === "string" ? metadata.name : "";
  const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
  const description =
    typeof metadata.description === "string" ? metadata.description.trim() : "";
  if (!validSkillName(name))
    throw new SkillError("invalid_role", 400, invalidNameMessage(name));
  if (!title || [...title].length > 100)
    throw new SkillError("invalid_role", 400, "Title: enter 1–100 characters.");
  if (!description || [...description].length > 1024)
    throw new SkillError(
      "invalid_role",
      400,
      "Description: enter 1–1,024 characters.",
    );
  return { name, title, description };
}

export { packageHash };
