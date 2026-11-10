import { SkillError } from "./skill-error.js";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  opendirSync,
} from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

export interface SkillFile {
  path: string;
  content: Buffer;
  mode: number;
}
const MAX_FILE = 512 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024;

export function readSkillFiles(root: string): SkillFile[] {
  const files: SkillFile[] = [];
  let total = 0;
  let entries = 0;
  function visit(dir: string, prefix: string): void {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new SkillError("invalid_skill", 400, "Invalid package directory");
    const directory = opendirSync(dir);
    try {
      for (
        let entry = directory.readSync();
        entry !== null;
        entry = directory.readSync()
      ) {
        entries += 1;
        if (entries > 1000)
          throw new SkillError(
            "package_limits",
            413,
            "Package exceeds entry limit",
          );
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (
          path.split("/").length > 32 ||
          Buffer.byteLength(path) > 512 ||
          /[\\\0]/.test(path) ||
          entry.name === "." ||
          entry.name === ".."
        )
          throw new SkillError("invalid_path", 400, "Invalid package path");
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(absolute, path);
          continue;
        }
        if (!entry.isFile())
          throw new SkillError(
            "invalid_path",
            400,
            "Links and special files are not allowed",
          );
        const fd = openSync(
          absolute,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const before = fstatSync(fd);
          if (!before.isFile() || before.nlink !== 1)
            throw new SkillError("invalid_path", 400, "Invalid package file");
          if (before.size > MAX_FILE)
            throw new SkillError(
              "package_limits",
              413,
              "Oversized package file",
            );
          total += before.size;
          if (total > MAX_TOTAL || files.length >= 1000)
            throw new SkillError(
              "package_limits",
              413,
              "Package exceeds limits",
            );
          const content = readFileSync(fd);
          const after = fstatSync(fd);
          if (
            content.length !== before.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.size !== after.size
          )
            throw new SkillError(
              "invalid_skill",
              400,
              "Package changed while reading",
            );
          files.push({ path, content, mode: before.mode & 0o777 });
        } finally {
          closeSync(fd);
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  visit(root, "");
  return files.sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
}

export function packageHash(files: SkillFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  )) {
    const path = Buffer.from(file.path);
    const header = Buffer.alloc(12);
    header.writeUInt32BE(path.length, 0);
    header.writeUInt32BE(file.mode, 4);
    header.writeUInt32BE(file.content.length, 8);
    hash.update(header).update(path).update(file.content);
  }
  return hash.digest("hex");
}

export function validSkillName(name: string): boolean {
  return (
    [...name].length <= 64 &&
    name === name.toLowerCase() &&
    /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name)
  );
}

export function skillMetadata(files: SkillFile[]): {
  name: string;
  description: string;
} {
  const file = files.find((item) => item.path === "SKILL.md");
  if (!file) throw new SkillError("invalid_skill", 400, "SKILL.md is required");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(file.content);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1])
    throw new SkillError("invalid_skill", 400, "SKILL.md needs frontmatter");
  const doc = parseDocument(match[1], { uniqueKeys: true, customTags: [] });
  if (doc.errors.length)
    throw new SkillError("invalid_skill", 400, "Invalid frontmatter");
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new SkillError("invalid_skill", 400, "Invalid frontmatter");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SkillError("invalid_skill", 400, "Frontmatter must be a mapping");
  const { name, description } = value as Record<string, unknown>;
  if (typeof name !== "string" || !validSkillName(name))
    throw new SkillError("invalid_skill", 400, "Invalid skill name");
  if (
    typeof description !== "string" ||
    !description.trim() ||
    [...description].length > 1024
  )
    throw new SkillError("invalid_skill", 400, "Invalid skill description");
  return { name, description };
}
