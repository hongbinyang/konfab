import { parseDocument } from "yaml";
import type { SkillFile } from "./skill-files.js";
import { skillMetadata } from "./skill-files.js";

/** What the page sends: the files the lead chose in the browser. */
export interface LocalUpload {
  source_name: string;
  single_file: boolean;
  files: Array<{ path: string; content_base64: string }>;
  /** For a folder without a top-level SKILL.md: the file the lead chose. */
  skill_file?: string;
  /** Files the lead chose to leave out. */
  leave_out?: string[];
}

export interface NormalizedUpload {
  files: SkillFile[];
  excluded: string[];
  /** Original path of the skill file, or null until one is chosen. */
  skill_file: string | null;
  /** Files whose contents look like a skill file. */
  candidates: string[];
  /** True when Konfab chose the only candidate (shown, never silent). */
  auto_chosen: boolean;
  destination_clash: string | null;
  broken_links: string[];
  missing_references: string[];
  errors: string[];
}

const MAX_FILE = 512 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024;
const MAX_FILES = 1000;
const IMPORTED_MODE = 0o644;

function looksLikeSkill(content: Buffer): boolean {
  try {
    skillMetadata([{ path: "SKILL.md", content, mode: IMPORTED_MODE }]);
    return true;
  } catch {
    return false;
  }
}

function unsafe(path: string): boolean {
  return (
    !path ||
    path.startsWith("/") ||
    /[\\\0]/.test(path) ||
    Buffer.byteLength(path) > 512 ||
    path.split("/").length > 32 ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  );
}

/** Relative links in a Markdown file: `](path)` and `` `dir/file.ext` ``. */
function relativeReferences(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = (match[1] ?? "").split("#")[0] ?? "";
    if (
      target &&
      !/^[a-z][a-z0-9+.-]*:/i.test(target) &&
      !target.startsWith("/")
    )
      found.add(target.replace(/^\.\//, ""));
  }
  for (const match of text.matchAll(/`([\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]+)`/g))
    if (match[1]) found.add(match[1].replace(/^\.\//, ""));
  return [...found].filter((path) => !unsafe(path));
}

/**
 * Turns the chosen files into a skill package: strips the chosen folder's own
 * name, leaves out `.DS_Store` and `.git/`, checks paths and limits, and moves
 * the skill file (whatever its name) to `SKILL.md`. Never guesses silently:
 * with no top-level `SKILL.md`, a single candidate is chosen and reported as
 * such, and several candidates wait for the lead's choice.
 */
export function normalizeUpload(upload: LocalUpload): NormalizedUpload {
  const errors: string[] = [];
  const excluded: string[] = [];
  let gitFiles = 0;
  const leaveOut = new Set(upload.leave_out ?? []);
  const files: SkillFile[] = [];
  for (const file of upload.files) {
    const raw = file.path.replace(/^\/+/, "");
    let path: string;
    if (upload.single_file) path = raw.split("/").pop() ?? "";
    else {
      const parts = raw.split("/");
      path = parts.length > 1 ? parts.slice(1).join("/") : raw;
    }
    if (unsafe(path)) {
      errors.push(`Unsafe file path: ${JSON.stringify(file.path)}.`);
      continue;
    }
    const parts = path.split("/");
    if (parts.includes(".git")) {
      gitFiles += 1;
      continue;
    }
    if (parts[parts.length - 1] === ".DS_Store") {
      excluded.push(path);
      continue;
    }
    if (leaveOut.has(path)) {
      excluded.push(path);
      continue;
    }
    files.push({
      path,
      content: Buffer.from(file.content_base64, "base64"),
      mode: IMPORTED_MODE,
    });
  }
  if (gitFiles)
    excluded.push(`.git/ (${gitFiles} file${gitFiles === 1 ? "" : "s"})`);

  const seen = new Map<string, string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    const other = seen.get(key);
    if (other)
      errors.push(
        other === file.path
          ? `${file.path} appears twice.`
          : `${other} and ${file.path} differ only in letter case; the Mac treats them as the same file.`,
      );
    seen.set(key, file.path);
  }
  let total = 0;
  for (const file of files) {
    total += file.content.length;
    if (file.content.length > MAX_FILE)
      errors.push(`${file.path} is larger than 512 KB.`);
  }
  if (total > MAX_TOTAL) errors.push("The files total more than 2 MB.");
  if (files.length >= MAX_FILES) errors.push("There are 1,000 files or more.");

  const candidates = files
    .filter((file) => looksLikeSkill(file.content))
    .map((file) => file.path);
  let skillFile: string | null = null;
  let auto = false;
  if (upload.single_file) skillFile = files[0]?.path ?? null;
  else if (files.some((file) => file.path === "SKILL.md"))
    skillFile = "SKILL.md";
  else if (
    upload.skill_file &&
    files.some((file) => file.path === upload.skill_file)
  )
    skillFile = upload.skill_file;
  else if (candidates.length === 1) {
    skillFile = candidates[0] ?? null;
    auto = true;
  }
  if (!files.length) errors.push("No files were chosen.");

  let clash: string | null = null;
  const brokenLinks: string[] = [];
  let missing: string[] = [];
  if (skillFile) {
    const chosen = skillFile;
    clash =
      files.find(
        (file) =>
          file.path !== chosen && file.path.toLowerCase() === "skill.md",
      )?.path ?? null;
    if (chosen !== "SKILL.md") {
      const base = chosen.split("/").pop() ?? chosen;
      for (const file of files)
        if (
          file.path !== chosen &&
          /\.(md|markdown|txt)$/i.test(file.path) &&
          file.content.toString("utf8").includes(base)
        )
          brokenLinks.push(file.path);
    }
    const manifest = files.find((file) => file.path === chosen);
    if (manifest && upload.single_file)
      missing = relativeReferences(manifest.content.toString("utf8"));
    for (let i = 0; i < files.length; i += 1)
      if (files[i]?.path === chosen)
        files[i] = { ...(files[i] as SkillFile), path: "SKILL.md" };
  }
  return {
    files: files.sort((a, b) =>
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
    ),
    excluded,
    skill_file: skillFile,
    candidates,
    auto_chosen: auto,
    destination_clash: clash,
    broken_links: brokenLinks,
    missing_references: missing,
    errors,
  };
}

/** Sets `name:` in the front matter of SKILL.md, keeping other keys and comments. */
export function renameManifest(files: SkillFile[], name: string): SkillFile[] {
  return files.map((file) => {
    if (file.path !== "SKILL.md") return file;
    const text = file.content.toString("utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match?.[1]) return file;
    const doc = parseDocument(match[1], { uniqueKeys: true, customTags: [] });
    doc.set("name", name);
    return {
      ...file,
      content: Buffer.from(
        `---\n${doc.toString()}---\n${text.slice(match[0].length)}`,
      ),
    };
  });
}

/** The `license` field of SKILL.md's front matter, if it is a short string. */
export function manifestLicence(files: SkillFile[]): string | null {
  const manifest = files.find((file) => file.path === "SKILL.md");
  if (!manifest) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(
    manifest.content.toString("utf8"),
  );
  if (!match?.[1]) return null;
  try {
    const value = parseDocument(match[1]).get("license");
    return typeof value === "string" && value.trim() && value.length <= 200
      ? value.trim()
      : null;
  } catch {
    return null;
  }
}
