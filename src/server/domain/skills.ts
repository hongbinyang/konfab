import { SkillError } from "./skill-error.js";
import { createHash, randomUUID } from "node:crypto";
import {
  readdirSync,
  linkSync,
  realpathSync,
  statSync,
  lstatSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { parseDocument } from "yaml";
import { join } from "node:path";
import type { Db } from "../db/index.js";
import {
  packageHash,
  readSkillFiles,
  skillMetadata,
  validSkillName,
  invalidNameMessage,
  type SkillFile,
} from "./skill-files.js";

const DRAFT_OWNER = ".konfab-draft-owner";
const RECOVERED_DRAFTS = ".konfab-recovered-drafts";

/**
 * Folder claims made by draft recovery: one `<draft id>.json` per draft in a
 * real (not symlinked) `.konfab-recovered-drafts` directory. Returns null when
 * that path exists but is not a real directory, or cannot be created.
 */
function recoveredDraftClaims(
  root: string,
  create: boolean,
): Array<{ draft: string; folder: string; path: string }> | null {
  const directory = join(root, RECOVERED_DRAFTS);
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch {
    if (!create) return [];
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch {
      return null;
    }
  }
  const claims: Array<{ draft: string; folder: string; path: string }> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as {
        recovered_from_draft?: unknown;
        folder?: unknown;
      };
      if (
        typeof value.recovered_from_draft === "string" &&
        typeof value.folder === "string" &&
        entry.name === `${value.recovered_from_draft}.json`
      )
        claims.push({
          draft: value.recovered_from_draft,
          folder: value.folder,
          path,
        });
    } catch {
      /* Not a claim. */
    }
  }
  return claims;
}

/** A stable UUID for a built-in skill, so library routes accept it and reseeding finds it. */
export function builtinSkillId(name: string): string {
  const hex = createHash("sha256")
    .update(`konfab-builtin-skill:${name}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Local library persistence. Filesystem operations are kept outside SQL transactions. */
export class SkillLibrary {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    try {
      this.recoverRenames();
    } catch {
      /* Keep inaccessible libraries pending for later recovery. */
    }
    try {
      this.recoverImports();
    } catch {
      /* Keep inaccessible libraries pending for later recovery. */
    }
    try {
      this.recoverAssignedWorkspaces();
    } catch {
      /* Retry inaccessible workspaces later. */
    }
    try {
      this.recoverImportDrafts();
    } catch {
      /* Keep drafts for a later start. */
    }
    this.cleanupTempFiles();
  }

  /**
   * Earlier versions could keep an imported skill as an unsaved draft in the
   * database. Drafts can no longer be opened, so each one is written out,
   * byte for byte, as an ordinary folder in its library: it then appears as
   * Untracked, with a diagnostic if it is still invalid, and the lead can fix
   * and adopt it.
   *
   * Each draft first claims a free folder name by creating
   * `.konfab-recovered-drafts/<draft id>.json` (never replacing an existing
   * file); the claim holds its metadata (provenance, licence, diagnostic and
   * dates), and adopting the folder applies its provenance and licence. Files
   * are written to a staging folder marked with the draft id, renamed into the
   * claimed name, and only then unmarked. The draft row is deleted last. A
   * restart resumes from whichever step was reached; folders and sidecars that
   * this recovery did not create are never changed or removed.
   */
  private recoverImportDrafts(): void {
    const drafts = this.db
      .prepare(
        `SELECT d.id, d.library_id, d.folder_name, d.provenance_json, d.licence, d.diagnostic,
           d.revision, d.created_at, d.updated_at, l.root_path
         FROM skill_import_drafts d JOIN skill_libraries l ON l.id = d.library_id ORDER BY d.created_at`,
      )
      .all() as Array<{
      id: string;
      library_id: string;
      folder_name: string;
      provenance_json: string;
      licence: string | null;
      diagnostic: string | null;
      revision: number;
      created_at: number;
      updated_at: number;
      root_path: string;
    }>;
    for (const draft of drafts) {
      try {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(draft.id)) continue;
        const root = lstatSync(draft.root_path);
        if (!root.isDirectory() || root.isSymbolicLink()) continue;
        const files = this.db
          .prepare(
            "SELECT path, content, mode FROM skill_import_draft_files WHERE draft_id = ? ORDER BY path",
          )
          .all(draft.id) as SkillFile[];
        for (const file of files) file.mode &= 0o777;
        if (
          files.some(
            (file) =>
              !file.path ||
              file.path === DRAFT_OWNER ||
              file.path.startsWith("/") ||
              /[\\\0]/.test(file.path) ||
              file.path
                .split("/")
                .some((part) => !part || part === "." || part === ".."),
          )
        )
          continue;
        const hash = packageHash(files);
        const claims = recoveredDraftClaims(draft.root_path, true);
        if (!claims) continue;
        const marked = (folder: string) => {
          const marker = join(folder, DRAFT_OWNER);
          try {
            return (
              lstatSync(marker).isFile() &&
              readFileSync(marker, "utf8") === draft.id
            );
          } catch {
            return false;
          }
        };
        const contentHash = (folder: string) =>
          packageHash(
            readSkillFiles(folder).filter((file) => file.path !== DRAFT_OWNER),
          );
        // Remove partial staging folders from an earlier attempt, but only ones this recovery marked as its own.
        for (const entry of readdirSync(draft.root_path, {
          withFileTypes: true,
        }))
          if (
            entry.isDirectory() &&
            entry.name.startsWith(`.konfab-draft-${draft.id}-`) &&
            marked(join(draft.root_path, entry.name))
          )
            rmSync(join(draft.root_path, entry.name), { recursive: true });

        // 1. Claim a folder name, or resume the claim an earlier start made.
        let claim = claims.find((item) => item.draft === draft.id);
        if (!claim) {
          const base =
            draft.folder_name.replace(/[^\p{L}\p{N}-]+/gu, "-") || "draft";
          const candidates = [base, `${base}-draft`];
          for (let n = 2; n < 100; n += 1)
            candidates.push(`${base}-draft-${n}`);
          const folder = candidates.find(
            (name) =>
              !claims.some((item) => item.folder === name) &&
              !this.db
                .prepare(
                  "SELECT 1 FROM skills WHERE library_id = ? AND folder_name = ?",
                )
                .get(draft.library_id, name) &&
              !existsSync(join(draft.root_path, name)),
          );
          if (!folder) continue;
          const metadata = {
            recovered_from_draft: draft.id,
            original_name: draft.folder_name,
            folder,
            provenance: JSON.parse(draft.provenance_json) as unknown,
            licence: draft.licence,
            diagnostic: draft.diagnostic,
            revision: draft.revision,
            created_at: draft.created_at,
            updated_at: draft.updated_at,
            recovered_at: this.now(),
          };
          const sidecar = join(
            draft.root_path,
            RECOVERED_DRAFTS,
            `${draft.id}.json`,
          );
          const temporary = `${sidecar}.${randomUUID()}.partial`;
          writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
            flag: "wx",
            mode: 0o600,
          });
          try {
            linkSync(temporary, sidecar); // fails if a file is already there
          } finally {
            unlinkSync(temporary);
          }
          claim = { draft: draft.id, folder, path: sidecar };
        }
        const target = join(draft.root_path, claim.folder);

        // 2. Write and promote the folder, unless an earlier start already did.
        if (!existsSync(target)) {
          const staging = join(
            draft.root_path,
            `.konfab-draft-${draft.id}-${randomUUID()}`,
          );
          mkdirSync(staging, { mode: 0o700 });
          writeFileSync(join(staging, DRAFT_OWNER), draft.id, {
            flag: "wx",
            mode: 0o600,
          });
          for (const file of files) {
            const destination = join(staging, file.path);
            mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
            writeFileSync(destination, file.content, {
              flag: "wx",
              mode: file.mode,
            });
            chmodSync(destination, file.mode); // not narrowed by the umask
          }
          if (contentHash(staging) !== hash || existsSync(target)) continue;
          renameSync(staging, target);
        } else {
          const stat = lstatSync(target);
          // The claimed name is ours only if it holds exactly this draft.
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            contentHash(target) !== hash
          )
            continue;
        }
        // 3. Unmark it, then forget the draft.
        if (marked(target)) unlinkSync(join(target, DRAFT_OWNER));
        if (existsSync(join(target, DRAFT_OWNER))) continue;
        this.db.transaction(() => {
          this.db
            .prepare("DELETE FROM skill_import_drafts WHERE id = ?")
            .run(draft.id);
          this.db
            .prepare(
              "INSERT INTO upgrade_log(kind, detail, created_at) VALUES ('recovered_draft', ?, ?)",
            )
            .run(
              `Import draft ${draft.folder_name} was saved as the untracked folder ${claim.folder}, with its details in ${claim.path}; fix it if needed and adopt it in Manage library`,
              this.now(),
            );
        })();
      } catch {
        /* Leave this draft for a later start. */
      }
    }
  }

  /** Provenance and licence of a folder recovered from an old import draft, if any. */
  private recoveredDraft(
    root: string,
    folder: string,
  ): { provenance: string; licence: string | null } | null {
    const claims = (recoveredDraftClaims(root, false) ?? []).filter(
      (item) => item.folder === folder,
    );
    if (claims.length !== 1 || !claims[0]) return null;
    try {
      const value = JSON.parse(readFileSync(claims[0].path, "utf8")) as {
        provenance?: Record<string, unknown>;
        licence?: string | null;
      };
      return {
        provenance: JSON.stringify({
          ...(value.provenance ?? {}),
          recovered_from_draft: claims[0].draft,
        }),
        licence: value.licence ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Writes working folders for skills whose saved revision is newer than the folder. Safe to repeat. */
  finishWorkspaces(): void {
    this.recoverAssignedWorkspaces();
  }

  private recoverAssignedWorkspaces(): void {
    const rows = this.db
      .prepare(
        `SELECT o.skill_id, o.revision_id, s.folder_name, l.root_path, r.content_hash, p.content_hash AS previous_hash
         FROM skill_workspace_operations o JOIN skills s ON s.id=o.skill_id JOIN skill_libraries l ON l.id=s.library_id
         JOIN skill_revisions r ON r.id=o.revision_id LEFT JOIN skill_revisions p ON p.id=o.previous_revision_id
         WHERE o.state='pending'`,
      )
      .all() as Array<{
      skill_id: string;
      revision_id: string;
      folder_name: string;
      root_path: string;
      content_hash: string;
      previous_hash: string | null;
    }>;
    for (const row of rows) {
      try {
        const root = lstatSync(row.root_path);
        if (!root.isDirectory() || root.isSymbolicLink()) continue;
        const folder = join(row.root_path, row.folder_name);
        const staging = join(row.root_path, `.konfab-pending-${row.skill_id}`);
        const marker = join(staging, ".konfab-workspace-owner");
        const replaced = join(
          row.root_path,
          `.konfab-replaced-${row.skill_id}`,
        );
        // An unmodified folder at the previous revision is moved aside, then rewritten below.
        if (existsSync(folder) && row.previous_hash) {
          const target = lstatSync(folder);
          if (
            target.isDirectory() &&
            !target.isSymbolicLink() &&
            !existsSync(replaced) &&
            packageHash(readSkillFiles(folder)) === row.previous_hash
          )
            renameSync(folder, replaced);
        }
        if (existsSync(folder)) {
          const target = lstatSync(folder);
          if (
            target.isDirectory() &&
            !target.isSymbolicLink() &&
            packageHash(readSkillFiles(folder)) === row.content_hash
          )
            this.db
              .prepare(
                "UPDATE skill_workspace_operations SET state='complete' WHERE skill_id=?",
              )
              .run(row.skill_id);
          if (
            existsSync(replaced) &&
            packageHash(readSkillFiles(folder)) === row.content_hash
          )
            rmSync(replaced, { recursive: true });
          continue;
        }
        if (existsSync(staging)) {
          const stat = lstatSync(staging);
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
          if (existsSync(marker)) {
            if (
              lstatSync(marker).isSymbolicLink() ||
              readFileSync(marker, "utf8") !== row.skill_id
            )
              continue;
            rmSync(staging, { recursive: true });
          } else if (readdirSync(staging).length === 0)
            rmSync(staging, { recursive: true });
          else if (packageHash(readSkillFiles(staging)) === row.content_hash) {
            if (!existsSync(folder)) renameSync(staging, folder);
            if (
              existsSync(folder) &&
              packageHash(readSkillFiles(folder)) === row.content_hash
            )
              this.db
                .prepare(
                  "UPDATE skill_workspace_operations SET state='complete' WHERE skill_id=?",
                )
                .run(row.skill_id);
            continue;
          } else continue;
        }
        mkdirSync(staging, { mode: 0o700 });
        writeFileSync(marker, row.skill_id, { flag: "wx", mode: 0o600 });
        const files = this.db
          .prepare(
            "SELECT f.path, f.mode, b.content FROM skill_revision_files f JOIN skill_blobs b ON b.hash=f.blob_hash WHERE f.revision_id=? ORDER BY f.path",
          )
          .all(row.revision_id) as SkillFile[];
        for (const file of files) {
          const destination = join(staging, file.path);
          mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
          writeFileSync(destination, file.content, {
            flag: "wx",
            mode: file.mode & 0o777,
          });
        }
        unlinkSync(marker);
        if (
          packageHash(readSkillFiles(staging)) !== row.content_hash ||
          existsSync(folder)
        )
          continue;
        // A concurrent rename can replace an empty directory, but cannot replace a non-empty one.
        // A conflict remains pending and is shown in Manage library for the user to resolve.
        renameSync(staging, folder);
        this.db
          .prepare(
            "UPDATE skill_workspace_operations SET state='complete' WHERE skill_id=?",
          )
          .run(row.skill_id);
        if (existsSync(replaced)) rmSync(replaced, { recursive: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "EEXIST" || code === "ENOTEMPTY") continue;
        /* Leave other failures pending for a safe retry and visible diagnosis. */
      }
    }
  }

  private recoverImports(): void {
    const rows = this.db
      .prepare(
        `SELECT o.*, l.root_path FROM skill_import_operations o JOIN skill_libraries l ON l.id = o.library_id ORDER BY o.created_at`,
      )
      .all() as Array<{
      id: string;
      library_id: string;
      folder_name: string;
      staging_name: string;
      provenance_json: string;
      licence: string | null;
      state: string;
      root_path: string;
    }>;
    for (const row of rows) {
      const staging = join(row.root_path, row.staging_name);
      const target = join(row.root_path, row.folder_name);
      try {
        if (existsSync(target) && !existsSync(staging)) {
          const tracked = this.db
            .prepare(
              "SELECT 1 FROM skills WHERE library_id = ? AND folder_name = ?",
            )
            .get(row.library_id, row.folder_name);
          if (!tracked)
            this.adopt(
              row.library_id,
              row.folder_name,
              row.provenance_json,
              row.licence,
            );
          this.db
            .prepare("DELETE FROM skill_import_operations WHERE id = ?")
            .run(row.id);
        } else if (existsSync(staging)) {
          rmSync(staging, { recursive: true });
          this.db
            .prepare("DELETE FROM skill_import_operations WHERE id = ?")
            .run(row.id);
        } else {
          this.db
            .prepare("DELETE FROM skill_import_operations WHERE id = ?")
            .run(row.id);
        }
      } catch {
        /* Retry this exact journal record on next startup. */
      }
    }
  }

  private cleanupTempFiles(): void {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.content_hash, l.root_path FROM skill_temp_files t JOIN skill_libraries l ON l.id = t.library_id WHERE t.created_at < ?`,
      )
      .all(this.now() - 24 * 60 * 60 * 1000) as {
      id: string;
      content_hash: string;
      root_path: string;
    }[];
    for (const row of rows) {
      const path = join(row.root_path, `.konfab-tmp-${row.id}`);
      try {
        if (existsSync(path)) {
          const stat = lstatSync(path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.size > 512 * 1024
          )
            continue;
          if (
            createHash("sha256").update(readFileSync(path)).digest("hex") !==
            row.content_hash
          )
            continue;
          unlinkSync(path);
        }
        this.db
          .prepare("DELETE FROM skill_temp_files WHERE id = ?")
          .run(row.id);
      } catch {
        /* Keep the record for later recovery. */
      }
    }
  }

  findLibrary(root: string): string | null {
    return (
      (
        this.db
          .prepare("SELECT id FROM skill_libraries WHERE root_path = ?")
          .get(root) as { id: string } | undefined
      )?.id ?? null
    );
  }

  registerLibrary(kind: "personal" | "project", root: string): string {
    if (!isAbsolute(root))
      throw new SkillError(
        "invalid_path",
        400,
        "Library path must be absolute",
      );
    const canonical = realpathSync(root);
    if (!statSync(canonical).isDirectory())
      throw new SkillError(
        "invalid_path",
        400,
        "Library path must be a directory",
      );
    const existing = this.db
      .prepare("SELECT id FROM skill_libraries WHERE root_path = ?")
      .get(canonical) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO skill_libraries(id, kind, root_path, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, kind, canonical, this.now());
    return id;
  }

  /** Seeds the read-only built-in skills shipped with Konfab; a changed file adds a reviewed revision. */
  seedBuiltins(root: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO skill_libraries(id, kind, root_path, created_at) VALUES ('builtin', 'builtin', ?, ?)",
      )
      .run(root, this.now());
    this.db
      .prepare("UPDATE skill_libraries SET root_path = ? WHERE id = 'builtin'")
      .run(root);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = readSkillFiles(join(root, entry.name));
      const metadata = skillMetadata(files);
      if (metadata.name !== entry.name)
        throw new SkillError(
          "invalid_skill",
          400,
          "Built-in skill name must match its folder",
        );
      // Look up by folder so a database seeded earlier keeps its skill identity.
      const id =
        (
          this.db
            .prepare(
              "SELECT id FROM skills WHERE library_id = 'builtin' AND folder_name = ?",
            )
            .get(entry.name) as { id: string } | undefined
        )?.id ?? builtinSkillId(entry.name);
      const hash = packageHash(files);
      const current = this.db
        .prepare(
          "SELECT r.content_hash FROM skills s LEFT JOIN skill_revisions r ON r.id = s.current_revision_id WHERE s.id = ?",
        )
        .get(id) as { content_hash: string | null } | undefined;
      if (current?.content_hash === hash) continue;
      const revision = randomUUID();
      this.db.transaction(() => {
        const number =
          (
            this.db
              .prepare(
                "SELECT COALESCE(MAX(number), 0) AS n FROM skill_revisions WHERE skill_id = ?",
              )
              .get(id) as { n: number }
          ).n + 1;
        this.db
          .prepare(
            "INSERT OR IGNORE INTO skills(id, library_id, folder_name, current_revision_id, created_at) VALUES (?, 'builtin', ?, NULL, ?)",
          )
          .run(id, entry.name, this.now());
        this.db
          .prepare(
            "INSERT INTO skill_revisions(id, skill_id, number, content_hash, name, description, provenance_json, licence, created_at) VALUES (?, ?, ?, ?, ?, ?, '{\"builtin\":true}', NULL, ?)",
          )
          .run(
            revision,
            id,
            number,
            hash,
            metadata.name,
            metadata.description,
            this.now(),
          );
        const blob = this.db.prepare(
          "INSERT OR IGNORE INTO skill_blobs(hash, content) VALUES (?, ?)",
        );
        const ref = this.db.prepare(
          "INSERT INTO skill_revision_files(revision_id, path, blob_hash, mode) VALUES (?, ?, ?, ?)",
        );
        for (const file of files) {
          const blobHash = createHash("sha256")
            .update(file.content)
            .digest("hex");
          blob.run(blobHash, file.content);
          ref.run(revision, file.path, blobHash, file.mode);
        }
        this.db
          .prepare(
            "INSERT INTO skill_reviews(revision_id, reviewed_at) VALUES (?, ?)",
          )
          .run(revision, this.now());
        this.db
          .prepare("UPDATE skills SET current_revision_id = ? WHERE id = ?")
          .run(revision, id);
      })();
    }
  }

  /** Built-in skills are read-only; duplicate one to change it. */
  private assertWritable(id: string): void {
    const row = this.db
      .prepare(
        "SELECT l.kind FROM skills s JOIN skill_libraries l ON l.id = s.library_id WHERE s.id = ?",
      )
      .get(id) as { kind: string } | undefined;
    if (row?.kind === "builtin")
      throw new SkillError(
        "read_only",
        409,
        "Built-in skills are read-only. Duplicate it to make an editable copy.",
      );
  }

  /** Drops usage rows whose assignment or turn no longer holds that revision. */
  purgeStaleUsages(): void {
    this.db
      .prepare(
        `DELETE FROM skill_usages WHERE
          (owner_type = 'turn' AND owner_id NOT IN (SELECT CAST(id AS TEXT) FROM turns WHERE state = 'active'))
          OR (owner_type = 'assignment' AND NOT EXISTS (
            SELECT 1 FROM room_member_skills p
            WHERE p.room_id || ':' || p.agent_id = skill_usages.owner_id
              AND p.skill_id = skill_usages.skill_id AND p.skill_revision_id = skill_usages.revision_id))`,
      )
      .run();
  }

  list(libraryId: string, trash = false) {
    this.purgeStaleUsages();
    const library = this.db
      .prepare("SELECT root_path FROM skill_libraries WHERE id = ?")
      .get(libraryId) as { root_path: string } | undefined;
    if (!library) throw new SkillError("unavailable", 404, "Library not found");
    const skills = (
      this.db
        .prepare(
          `SELECT s.id, s.folder_name, s.current_revision_id, s.trashed_at,
      r.name, r.number, r.description, r.content_hash, r.licence, r.provenance_json, sr.reviewed_at,
      (SELECT COUNT(*) FROM skill_usages u WHERE u.skill_id = s.id) AS usage_count,
      (SELECT state FROM skill_workspace_operations o WHERE o.skill_id = s.id) AS workspace_state
      FROM skills s LEFT JOIN skill_revisions r ON r.id = s.current_revision_id
      LEFT JOIN skill_reviews sr ON sr.revision_id = r.id
      WHERE s.library_id = ? AND (s.trashed_at IS NOT NULL) = ? ORDER BY s.folder_name`,
        )
        .all(libraryId, trash ? 1 : 0) as Record<string, unknown>[]
    ).map((skill) => {
      try {
        return {
          ...skill,
          is_draft:
            packageHash(
              readSkillFiles(
                join(library.root_path, String(skill.folder_name)),
              ),
            ) !== skill.content_hash,
        };
      } catch {
        return { ...skill, is_draft: null };
      }
    });
    if (trash) return { skills, untracked: [] as string[] };
    const known = new Set(
      (
        this.db
          .prepare("SELECT folder_name FROM skills WHERE library_id = ?")
          .all(libraryId) as { folder_name: string }[]
      ).map((r) => r.folder_name),
    );
    if (!existsSync(library.root_path))
      return { skills, untracked: [] as string[], unavailable: true };
    const untracked = readdirSync(library.root_path, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".konfab-") &&
          !known.has(entry.name),
      )
      .map((entry) => entry.name);
    const untracked_details = untracked.map((folder) => {
      try {
        const metadata = skillMetadata(
          readSkillFiles(join(library.root_path, folder)),
        );
        return {
          folder,
          diagnostic:
            metadata.name === folder
              ? null
              : "Skill name does not match its folder",
        };
      } catch (error) {
        return {
          folder,
          diagnostic:
            error instanceof Error ? error.message : "Invalid skill package",
        };
      }
    });
    return { skills, untracked, untracked_details };
  }

  readFile(id: string, path: string): Buffer {
    const row = this.db
      .prepare(
        `SELECT s.folder_name, l.root_path FROM skills s
      JOIN skill_libraries l ON l.id = s.library_id WHERE s.id = ?`,
      )
      .get(id) as { folder_name: string; root_path: string } | undefined;
    if (!row) throw new SkillError("unavailable", 404, "Skill unavailable");
    const file = readSkillFiles(join(row.root_path, row.folder_name)).find(
      (item) => item.path === path,
    );
    if (!file) throw new SkillError("invalid_path", 400, "File unavailable");
    return file.content;
  }

  writeFile(
    id: string,
    path: string,
    content: Buffer,
    baseRevision: string,
    baseDraftHash: string,
  ): string {
    this.assertWritable(id);
    this.recoverRenames(id);
    if (content.length > 512 * 1024)
      throw new SkillError("package_limits", 413, "File exceeds size limit");
    if (
      !path ||
      path.startsWith("/") ||
      /[\\\0]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      path.split("/").length > 32 ||
      Buffer.byteLength(path) > 512
    )
      throw new SkillError("invalid_path", 400, "Invalid file path");
    const row = this.db
      .prepare(
        `SELECT s.folder_name, s.current_revision_id, s.trashed_at, s.library_id, l.root_path FROM skills s
      JOIN skill_libraries l ON l.id = s.library_id WHERE s.id = ?`,
      )
      .get(id) as
      | {
          folder_name: string;
          current_revision_id: string;
          trashed_at: number | null;
          root_path: string;
          library_id: string;
        }
      | undefined;
    if (!row || row.trashed_at !== null)
      throw new SkillError("unavailable", 404, "Skill unavailable");
    const root = join(row.root_path, row.folder_name);
    const initial = readSkillFiles(root);
    if (
      row.current_revision_id !== baseRevision ||
      packageHash(initial) !== baseDraftHash
    )
      throw new SkillError("draft_conflict", 409, "Draft conflict");
    const newTotal =
      initial.reduce(
        (sum, file) => sum + (file.path === path ? 0 : file.content.length),
        0,
      ) + content.length;
    if (
      newTotal > 2 * 1024 * 1024 ||
      (!initial.some((file) => file.path === path) && initial.length >= 1000)
    )
      throw new SkillError("package_limits", 413, "Package exceeds limits");
    const segments = path.split("/");
    const leaf = segments.pop()!;
    let parent = root;
    for (const segment of segments) {
      parent = join(parent, segment);
      if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new SkillError("invalid_path", 400, "Invalid parent folder");
    }
    const target = join(parent, leaf);
    let fileMode = 0o600;
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new SkillError("invalid_path", 400, "Invalid target file");
      fileMode = stat.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const tempId = randomUUID();
    const temp = join(row.root_path, `.konfab-tmp-${tempId}`);
    this.db
      .prepare(
        "INSERT INTO skill_temp_files(id, library_id, content_hash, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        tempId,
        row.library_id,
        createHash("sha256").update(content).digest("hex"),
        this.now(),
      );
    try {
      writeFileSync(temp, content, { flag: "wx", mode: fileMode });
      chmodSync(temp, fileMode);
      if (packageHash(readSkillFiles(root)) !== baseDraftHash)
        throw new SkillError("draft_conflict", 409, "Draft conflict");
      renameSync(temp, target);
      return packageHash([
        ...initial.filter((file) => file.path !== path),
        { path, content, mode: fileMode },
      ]);
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* already renamed */
      }
      if (!existsSync(temp))
        this.db
          .prepare("DELETE FROM skill_temp_files WHERE id = ?")
          .run(tempId);
    }
  }

  deleteFile(
    id: string,
    path: string,
    baseRevision: string,
    baseDraftHash: string,
  ): string {
    this.assertWritable(id);
    this.recoverRenames(id);
    const row = this.db
      .prepare(
        `SELECT s.folder_name, s.current_revision_id, s.trashed_at, l.root_path FROM skills s JOIN skill_libraries l ON l.id = s.library_id WHERE s.id = ?`,
      )
      .get(id) as
      | {
          folder_name: string;
          current_revision_id: string;
          trashed_at: number | null;
          root_path: string;
        }
      | undefined;
    if (!row || row.trashed_at !== null)
      throw new SkillError("unavailable", 404, "Skill unavailable");
    const root = join(row.root_path, row.folder_name),
      files = readSkillFiles(root);
    if (
      row.current_revision_id !== baseRevision ||
      packageHash(files) !== baseDraftHash
    )
      throw new SkillError("draft_conflict", 409, "Draft conflict");
    if (!files.some((file) => file.path === path))
      throw new SkillError("invalid_path", 400, "File unavailable");
    if (path === "SKILL.md")
      throw new SkillError("invalid_skill", 400, "SKILL.md is required");
    if (packageHash(readSkillFiles(root)) !== baseDraftHash)
      throw new SkillError("draft_conflict", 409, "Draft conflict");
    unlinkSync(join(root, path));
    return packageHash(files.filter((file) => file.path !== path));
  }

  detail(id: string) {
    this.recoverRenames(id);
    const row = this.db
      .prepare(
        `SELECT s.id, s.folder_name, s.current_revision_id, s.trashed_at,
      l.root_path, r.content_hash, r.name, r.description, r.licence, r.provenance_json, sr.reviewed_at
      FROM skills s JOIN skill_libraries l ON l.id = s.library_id
      JOIN skill_revisions r ON r.id = s.current_revision_id
      LEFT JOIN skill_reviews sr ON sr.revision_id = r.id WHERE s.id = ?`,
      )
      .get(id) as
      | {
          id: string;
          folder_name: string;
          current_revision_id: string;
          trashed_at: number | null;
          root_path: string;
          content_hash: string;
          name: string;
          description: string;
          licence: string | null;
          provenance_json: string;
          reviewed_at: number | null;
        }
      | undefined;
    if (!row) throw new SkillError("unavailable", 404, "Skill unavailable");
    try {
      const files = readSkillFiles(join(row.root_path, row.folder_name));
      const draftHash = packageHash(files);
      return {
        ...row,
        draft_hash: draftHash,
        is_draft: draftHash !== row.content_hash,
        files: files.map((file) => ({
          path: file.path,
          size: file.content.length,
        })),
        draft_error: null,
      };
    } catch (error) {
      return {
        ...row,
        draft_hash: null,
        is_draft: null,
        files: [],
        draft_error:
          error instanceof Error ? error.message : "Draft unavailable",
      };
    }
  }

  revisionFiles(skillId: string, revisionId: string) {
    const revision = this.db
      .prepare(
        "SELECT id, name, description, content_hash, created_at FROM skill_revisions WHERE skill_id = ? AND id = ?",
      )
      .get(skillId, revisionId);
    if (!revision)
      throw new SkillError("unavailable", 404, "Revision unavailable");
    const files = this.db
      .prepare(
        `SELECT f.path, f.mode, b.content FROM skill_revision_files f JOIN skill_blobs b ON b.hash = f.blob_hash WHERE f.revision_id = ? ORDER BY f.path`,
      )
      .all(revisionId) as { path: string; mode: number; content: Buffer }[];
    return {
      revision,
      files: files.map((file) => ({
        path: file.path,
        size: file.content.length,
      })),
    };
  }

  readRevisionFile(skillId: string, revisionId: string, path: string): Buffer {
    const file = this.db
      .prepare(
        `SELECT b.content FROM skill_revisions r JOIN skill_revision_files f ON f.revision_id = r.id JOIN skill_blobs b ON b.hash = f.blob_hash WHERE r.skill_id = ? AND r.id = ? AND f.path = ?`,
      )
      .get(skillId, revisionId, path) as { content: Buffer } | undefined;
    if (!file)
      throw new SkillError("invalid_path", 400, "Revision file unavailable");
    return file.content;
  }

  revisions(id: string) {
    return this.db
      .prepare(
        `SELECT r.id, r.number, r.name, r.description, r.content_hash,
      r.created_at, sr.reviewed_at FROM skill_revisions r LEFT JOIN skill_reviews sr
      ON sr.revision_id = r.id WHERE r.skill_id = ? ORDER BY r.number DESC`,
      )
      .all(id);
  }

  restore(id: string, baseRevision: string, baseDraftHash: string): void {
    this.assertWritable(id);
    this.recoverRenames(id);
    const row = this.db
      .prepare(
        `SELECT s.folder_name, s.current_revision_id, s.trashed_at, l.root_path FROM skills s
      JOIN skill_libraries l ON l.id = s.library_id WHERE s.id = ?`,
      )
      .get(id) as
      | {
          folder_name: string;
          current_revision_id: string;
          trashed_at: number | null;
          root_path: string;
        }
      | undefined;
    if (!row || row.trashed_at === null)
      throw new SkillError("invalid_skill", 400, "Skill is not in Trash");
    // Reading ensures the folder is still present and obeys package bounds.
    if (
      row.current_revision_id !== baseRevision ||
      packageHash(readSkillFiles(join(row.root_path, row.folder_name))) !==
        baseDraftHash
    )
      throw new SkillError("draft_conflict", 409, "Draft conflict");
    this.db
      .prepare(
        "UPDATE skills SET trashed_at = NULL WHERE id = ? AND current_revision_id = ? AND trashed_at IS NOT NULL",
      )
      .run(id, baseRevision);
  }

  markReviewed(skillId: string, revisionId: string): void {
    this.recoverRenames(skillId);
    const revision = this.db
      .prepare("SELECT 1 FROM skill_revisions WHERE id = ? AND skill_id = ?")
      .get(revisionId, skillId);
    if (!revision)
      throw new SkillError("unavailable", 404, "Revision unavailable");
    this.db
      .prepare(
        "INSERT OR REPLACE INTO skill_reviews(revision_id, reviewed_at) VALUES (?, ?)",
      )
      .run(revisionId, this.now());
  }

  trash(id: string, baseRevision: string, baseDraftHash: string): void {
    this.assertWritable(id);
    this.recoverRenames(id);
    const row = this.db
      .prepare(
        `SELECT s.folder_name, s.current_revision_id, s.trashed_at, l.root_path
      FROM skills s JOIN skill_libraries l ON l.id = s.library_id WHERE s.id = ?`,
      )
      .get(id) as
      | {
          folder_name: string;
          current_revision_id: string;
          trashed_at: number | null;
          root_path: string;
        }
      | undefined;
    if (!row || row.trashed_at !== null)
      throw new SkillError("unavailable", 404, "Skill unavailable");
    if (
      row.current_revision_id !== baseRevision ||
      packageHash(readSkillFiles(join(row.root_path, row.folder_name))) !==
        baseDraftHash
    )
      throw new SkillError("draft_conflict", 409, "Draft conflict");
    this.purgeStaleUsages();
    this.db.transaction(() => {
      const uses = this.db
        .prepare("SELECT label FROM skill_usages WHERE skill_id = ?")
        .all(id) as { label: string }[];
      if (uses.length)
        throw new SkillError(
          "skill_in_use",
          409,
          `Skill in use: ${uses.map((use) => use.label).join(", ")}`,
        );
      const changed = this.db
        .prepare(
          "UPDATE skills SET trashed_at = ? WHERE id = ? AND current_revision_id = ? AND trashed_at IS NULL",
        )
        .run(this.now(), id, baseRevision);
      if (changed.changes !== 1)
        throw new SkillError("draft_conflict", 409, "Revision conflict");
    })();
  }

  save(id: string, baseRevision: string, baseDraftHash: string): string {
    this.assertWritable(id);
    this.recoverRenames(id);
    const row = this.db
      .prepare(
        `SELECT s.library_id, s.folder_name, s.current_revision_id, s.trashed_at, l.root_path
      FROM skills s JOIN skill_libraries l ON l.id = s.library_id WHERE s.id = ?`,
      )
      .get(id) as
      | {
          folder_name: string;
          current_revision_id: string;
          trashed_at: number | null;
          root_path: string;
        }
      | undefined;
    if (!row || row.trashed_at !== null)
      throw new SkillError("unavailable", 404, "Skill unavailable");
    if (row.current_revision_id !== baseRevision)
      throw new SkillError("draft_conflict", 409, "Revision conflict");
    const files = readSkillFiles(join(row.root_path, row.folder_name));
    const hash = packageHash(files);
    if (hash !== baseDraftHash)
      throw new SkillError("draft_conflict", 409, "Draft conflict");
    const meta = skillMetadata(files);
    if (meta.name !== row.folder_name)
      throw new SkillError(
        "invalid_skill",
        400,
        "Rename requires the rename operation",
      );
    const revision = randomUUID();
    this.db.transaction(() => {
      const current = this.db
        .prepare(
          "SELECT current_revision_id FROM skills WHERE id = ? AND trashed_at IS NULL",
        )
        .get(id) as { current_revision_id: string } | undefined;
      if (current?.current_revision_id !== baseRevision)
        throw new SkillError("draft_conflict", 409, "Revision conflict");
      const prior = this.db
        .prepare(
          "SELECT number, provenance_json, licence FROM skill_revisions WHERE id = ? AND skill_id = ?",
        )
        .get(baseRevision, id) as
        | { number: number; provenance_json: string; licence: string | null }
        | undefined;
      if (!prior)
        throw new SkillError("unavailable", 404, "Revision unavailable");
      this.db
        .prepare(
          "INSERT INTO skill_revisions(id, skill_id, number, content_hash, name, description, provenance_json, licence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          revision,
          id,
          prior.number + 1,
          hash,
          meta.name,
          meta.description,
          prior.provenance_json,
          prior.licence,
          this.now(),
        );
      const blob = this.db.prepare(
        "INSERT OR IGNORE INTO skill_blobs(hash, content) VALUES (?, ?)",
      );
      const ref = this.db.prepare(
        "INSERT INTO skill_revision_files(revision_id, path, blob_hash, mode) VALUES (?, ?, ?, ?)",
      );
      for (const file of files) {
        const digest = createHash("sha256").update(file.content).digest("hex");
        blob.run(digest, file.content);
        ref.run(revision, file.path, digest, file.mode);
      }
      this.db
        .prepare("UPDATE skills SET current_revision_id = ? WHERE id = ?")
        .run(revision, id);
    })();
    return revision;
  }

  private recoverRenames(skillId?: string): void {
    const operations = this.db
      .prepare(
        `SELECT o.*, l.root_path FROM skill_rename_operations o JOIN skills s ON s.id = o.skill_id JOIN skill_libraries l ON l.id = s.library_id`,
      )
      .all() as {
      skill_id: string;
      old_name: string;
      new_name: string;
      old_hash: string;
      new_hash: string;
      state: "prepared" | "committed";
      owns_destination: number;
      root_path: string;
    }[];
    for (const operation of operations) {
      if (skillId && operation.skill_id !== skillId) continue;
      const old = join(operation.root_path, operation.old_name);
      const dest = join(operation.root_path, operation.new_name);
      const backup = join(
        operation.root_path,
        `.konfab-backup-${operation.skill_id}`,
      );
      if (!existsSync(operation.root_path))
        throw new SkillError(
          "unavailable",
          404,
          "Rename recovery: library unavailable",
        );
      if (operation.old_name === operation.new_name) {
        const stage = join(
          operation.root_path,
          `.konfab-restore-${operation.skill_id}`,
        );
        if (operation.state === "prepared") {
          if (existsSync(backup)) {
            if (packageHash(readSkillFiles(backup)) !== operation.old_hash)
              throw new SkillError(
                "recovery_needed",
                409,
                "Restore backup changed; recovery requires attention",
              );
            if (existsSync(old)) {
              if (packageHash(readSkillFiles(old)) !== operation.new_hash)
                throw new SkillError(
                  "recovery_needed",
                  409,
                  "Restored folder changed; recovery requires attention",
                );
              rmSync(old, { recursive: true });
            }
            renameSync(backup, old);
          } else if (!existsSync(old))
            throw new SkillError(
              "invalid_path",
              400,
              "Restore recovery: original folder unavailable",
            );
          if (operation.owns_destination === 1 && existsSync(stage)) {
            try {
              if (packageHash(readSkillFiles(stage)) === operation.new_hash)
                rmSync(stage, { recursive: true });
            } catch {
              /* preserve incomplete stage */
            }
          }
        } else if (existsSync(backup)) {
          if (
            !existsSync(old) ||
            packageHash(readSkillFiles(old)) !== operation.new_hash
          )
            throw new SkillError(
              "recovery_needed",
              409,
              "Restored folder changed; recovery requires attention",
            );
          if (packageHash(readSkillFiles(backup)) !== operation.old_hash)
            throw new SkillError(
              "recovery_needed",
              409,
              "Restore backup changed; recovery requires attention",
            );
          rmSync(backup, { recursive: true });
        }
      } else if (operation.state === "prepared") {
        if (!existsSync(backup) && !existsSync(old))
          throw new SkillError(
            "invalid_path",
            400,
            "Rename recovery: original folder unavailable",
          );
        if (existsSync(backup)) {
          if (
            existsSync(old) ||
            packageHash(readSkillFiles(backup)) !== operation.old_hash
          )
            throw new SkillError(
              "invalid_skill",
              400,
              "Rename recovery requires attention",
            );
          renameSync(backup, old);
        }
        if (operation.owns_destination === 1 && existsSync(dest)) {
          try {
            if (packageHash(readSkillFiles(dest)) === operation.new_hash)
              rmSync(dest, { recursive: true });
          } catch {
            /* preserve incomplete destination */
          }
        }
      } else if (existsSync(backup)) {
        if (
          !existsSync(dest) ||
          packageHash(readSkillFiles(dest)) !== operation.new_hash
        )
          throw new SkillError(
            "recovery_needed",
            409,
            "Renamed folder changed; recovery requires attention",
          );
        if (packageHash(readSkillFiles(backup)) !== operation.old_hash)
          throw new SkillError(
            "invalid_skill",
            400,
            "Rename backup changed; recovery requires attention",
          );
        rmSync(backup, { recursive: true });
      }
      this.db
        .prepare("DELETE FROM skill_rename_operations WHERE skill_id = ?")
        .run(operation.skill_id);
    }
  }

  restoreRevision(
    id: string,
    sourceRevision: string,
    baseRevision: string,
    baseDraftHash: string,
  ): string {
    this.assertWritable(id);
    this.recoverRenames(id);
    const row = this.db
      .prepare(
        `SELECT s.folder_name, s.current_revision_id, s.trashed_at, l.root_path FROM skills s JOIN skill_libraries l ON l.id = s.library_id WHERE s.id = ?`,
      )
      .get(id) as
      | {
          folder_name: string;
          current_revision_id: string;
          trashed_at: number | null;
          root_path: string;
        }
      | undefined;
    if (!row || row.trashed_at !== null)
      throw new SkillError("unavailable", 404, "Skill unavailable");
    const original = join(row.root_path, row.folder_name),
      stage = join(row.root_path, `.konfab-restore-${id}`),
      backup = join(row.root_path, `.konfab-backup-${id}`);
    if (
      row.current_revision_id !== baseRevision ||
      packageHash(readSkillFiles(original)) !== baseDraftHash
    )
      throw new SkillError("draft_conflict", 409, "Draft conflict");
    if (existsSync(stage) || existsSync(backup))
      throw new SkillError(
        "invalid_path",
        400,
        "Recovery folders already exist",
      );
    const source = this.db
      .prepare(
        "SELECT provenance_json, licence FROM skill_revisions WHERE id = ? AND skill_id = ?",
      )
      .get(sourceRevision, id) as
      { provenance_json: string; licence: string | null } | undefined;
    if (!source)
      throw new SkillError("unavailable", 404, "Revision unavailable");
    const files = this.db
      .prepare(
        `SELECT f.path, f.mode, b.content FROM skill_revision_files f JOIN skill_blobs b ON b.hash = f.blob_hash WHERE f.revision_id = ? ORDER BY f.path`,
      )
      .all(sourceRevision) as { path: string; mode: number; content: Buffer }[];
    const manifest = files.find((file) => file.path === "SKILL.md");
    if (!manifest)
      throw new SkillError("unavailable", 404, "Manifest unavailable");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      manifest.content,
    );
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match?.[1])
      throw new SkillError("invalid_skill", 400, "Invalid manifest");
    const doc = parseDocument(match[1], { uniqueKeys: true, customTags: [] });
    if (doc.errors.length)
      throw new SkillError("invalid_skill", 400, "Invalid manifest");
    doc.set("name", row.folder_name);
    const changed = files.map((file) =>
      file.path === "SKILL.md"
        ? {
            ...file,
            content: Buffer.from(
              `---\n${doc.toString()}---\n${text.slice(match[0].length)}`,
            ),
          }
        : file,
    );
    const metadata = skillMetadata(changed),
      hash = packageHash(changed),
      revision = randomUUID();
    if (
      changed.reduce((sum, file) => sum + file.content.length, 0) >
        2 * 1024 * 1024 ||
      changed.some((file) => file.content.length > 512 * 1024)
    )
      throw new SkillError("package_limits", 413, "Package exceeds limits");
    this.db
      .prepare(
        "INSERT INTO skill_rename_operations(skill_id, old_name, new_name, old_hash, new_hash, state, created_at) VALUES (?, ?, ?, ?, ?, 'prepared', ?)",
      )
      .run(
        id,
        row.folder_name,
        row.folder_name,
        baseDraftHash,
        hash,
        this.now(),
      );
    try {
      mkdirSync(stage);
      this.db
        .prepare(
          "UPDATE skill_rename_operations SET owns_destination = 1 WHERE skill_id = ?",
        )
        .run(id);
      for (const file of changed) {
        const output = join(stage, file.path);
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, file.content, { flag: "wx", mode: file.mode });
        chmodSync(output, file.mode);
      }
      if (
        packageHash(readSkillFiles(original)) !== baseDraftHash ||
        packageHash(readSkillFiles(stage)) !== hash
      )
        throw new SkillError("draft_conflict", 409, "Draft conflict");
      renameSync(original, backup);
      renameSync(stage, original);
      this.db.transaction(() => {
        const prior = this.db
          .prepare(
            "SELECT number FROM skill_revisions WHERE id = ? AND skill_id = ?",
          )
          .get(baseRevision, id) as { number: number } | undefined;
        const current = this.db
          .prepare(
            "SELECT current_revision_id FROM skills WHERE id = ? AND trashed_at IS NULL",
          )
          .get(id) as { current_revision_id: string } | undefined;
        if (!prior || current?.current_revision_id !== baseRevision)
          throw new SkillError("draft_conflict", 409, "Revision conflict");
        this.db
          .prepare(
            "INSERT INTO skill_revisions(id, skill_id, number, content_hash, name, description, provenance_json, licence, created_at, restored_from_revision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            revision,
            id,
            prior.number + 1,
            hash,
            metadata.name,
            metadata.description,
            source.provenance_json,
            source.licence,
            this.now(),
            sourceRevision,
          );
        const blob = this.db.prepare(
          "INSERT OR IGNORE INTO skill_blobs(hash, content) VALUES (?, ?)",
        );
        const ref = this.db.prepare(
          "INSERT INTO skill_revision_files(revision_id, path, blob_hash, mode) VALUES (?, ?, ?, ?)",
        );
        for (const file of changed) {
          const digest = createHash("sha256")
            .update(file.content)
            .digest("hex");
          blob.run(digest, file.content);
          ref.run(revision, file.path, digest, file.mode);
        }
        this.db
          .prepare("UPDATE skills SET current_revision_id = ? WHERE id = ?")
          .run(revision, id);
        this.db
          .prepare(
            "UPDATE skill_rename_operations SET state = 'committed' WHERE skill_id = ?",
          )
          .run(id);
      })();
      this.recoverRenames(id);
      return revision;
    } catch (error) {
      this.recoverRenames(id);
      throw error;
    }
  }

  rename(
    id: string,
    name: string,
    baseRevision: string,
    baseDraftHash: string,
  ): string {
    this.assertWritable(id);
    if (!validSkillName(name))
      throw new SkillError("invalid_skill", 400, invalidNameMessage(name));
    this.recoverRenames(id);
    const row = this.db
      .prepare(
        `SELECT s.folder_name, s.current_revision_id, s.trashed_at, l.root_path FROM skills s JOIN skill_libraries l ON l.id = s.library_id WHERE s.id = ?`,
      )
      .get(id) as
      | {
          folder_name: string;
          current_revision_id: string;
          trashed_at: number | null;
          root_path: string;
        }
      | undefined;
    if (!row || row.trashed_at !== null)
      throw new SkillError("unavailable", 404, "Skill unavailable");
    if (name === row.folder_name)
      throw new SkillError("name_conflict", 409, "Name is unchanged");
    const old = join(row.root_path, row.folder_name),
      dest = join(row.root_path, name),
      backup = join(row.root_path, `.konfab-backup-${id}`);
    const files = readSkillFiles(old);
    if (
      row.current_revision_id !== baseRevision ||
      packageHash(files) !== baseDraftHash
    )
      throw new SkillError("draft_conflict", 409, "Draft conflict");
    if (existsSync(dest) || existsSync(backup))
      throw new SkillError("name_conflict", 409, "Name already exists");
    const manifest = files.find((file) => file.path === "SKILL.md");
    if (!manifest)
      throw new SkillError("invalid_skill", 400, "SKILL.md is required");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      manifest.content,
    );
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match?.[1])
      throw new SkillError("invalid_skill", 400, "Invalid manifest");
    const doc = parseDocument(match[1], { uniqueKeys: true, customTags: [] });
    if (doc.errors.length)
      throw new SkillError("invalid_skill", 400, "Invalid manifest");
    doc.set("name", name);
    const changed = files.map((file) =>
      file.path === "SKILL.md"
        ? {
            ...file,
            content: Buffer.from(
              `---\n${doc.toString()}---\n${text.slice(match[0].length)}`,
            ),
          }
        : file,
    );
    const metadata = skillMetadata(changed),
      newHash = packageHash(changed),
      revision = randomUUID();
    if (
      changed.reduce((sum, file) => sum + file.content.length, 0) >
        2 * 1024 * 1024 ||
      changed.some((file) => file.content.length > 512 * 1024)
    )
      throw new SkillError("package_limits", 413, "Package exceeds limits");
    this.db
      .prepare(
        "INSERT INTO skill_rename_operations(skill_id, old_name, new_name, old_hash, new_hash, state, created_at) VALUES (?, ?, ?, ?, ?, 'prepared', ?)",
      )
      .run(id, row.folder_name, name, baseDraftHash, newHash, this.now());
    try {
      mkdirSync(dest);
      this.db
        .prepare(
          "UPDATE skill_rename_operations SET owns_destination = 1 WHERE skill_id = ?",
        )
        .run(id);
      for (const file of changed) {
        const output = join(dest, file.path);
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, file.content, { flag: "wx", mode: file.mode });
        chmodSync(output, file.mode);
      }
      if (
        packageHash(readSkillFiles(old)) !== baseDraftHash ||
        packageHash(readSkillFiles(dest)) !== newHash
      )
        throw new SkillError("draft_conflict", 409, "Draft conflict");
      renameSync(old, backup);
      this.db.transaction(() => {
        const prior = this.db
          .prepare(
            "SELECT number, provenance_json, licence FROM skill_revisions WHERE id = ? AND skill_id = ?",
          )
          .get(baseRevision, id) as
          | { number: number; provenance_json: string; licence: string | null }
          | undefined;
        const current = this.db
          .prepare(
            "SELECT current_revision_id FROM skills WHERE id = ? AND trashed_at IS NULL",
          )
          .get(id) as { current_revision_id: string } | undefined;
        if (!prior || current?.current_revision_id !== baseRevision)
          throw new SkillError("draft_conflict", 409, "Revision conflict");
        this.db
          .prepare(
            "INSERT INTO skill_revisions(id, skill_id, number, content_hash, name, description, provenance_json, licence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            revision,
            id,
            prior.number + 1,
            newHash,
            metadata.name,
            metadata.description,
            prior.provenance_json,
            prior.licence,
            this.now(),
          );
        const blob = this.db.prepare(
          "INSERT OR IGNORE INTO skill_blobs(hash, content) VALUES (?, ?)",
        );
        const ref = this.db.prepare(
          "INSERT INTO skill_revision_files(revision_id, path, blob_hash, mode) VALUES (?, ?, ?, ?)",
        );
        for (const file of changed) {
          const hash = createHash("sha256").update(file.content).digest("hex");
          blob.run(hash, file.content);
          ref.run(revision, file.path, hash, file.mode);
        }
        this.db
          .prepare(
            "UPDATE skills SET folder_name = ?, current_revision_id = ? WHERE id = ?",
          )
          .run(name, revision, id);
        this.db
          .prepare(
            "UPDATE skill_rename_operations SET state = 'committed' WHERE skill_id = ?",
          )
          .run(id);
      })();
      this.recoverRenames(id);
      return revision;
    } catch (error) {
      this.recoverRenames(id);
      throw error;
    }
  }

  duplicate(
    sourceId: string,
    revisionId: string,
    libraryId: string,
    name: string,
  ): string {
    if (!validSkillName(name))
      throw new SkillError("invalid_skill", 400, invalidNameMessage(name));
    const source = this.db
      .prepare("SELECT id FROM skill_revisions WHERE id = ? AND skill_id = ?")
      .get(revisionId, sourceId);
    const lib = this.db
      .prepare("SELECT root_path FROM skill_libraries WHERE id = ?")
      .get(libraryId) as { root_path: string } | undefined;
    if (!source || !lib)
      throw new SkillError("unavailable", 404, "Source or library unavailable");
    const files = this.db
      .prepare(
        `SELECT f.path, f.mode, b.content FROM skill_revision_files f JOIN skill_blobs b ON b.hash = f.blob_hash WHERE f.revision_id = ? ORDER BY f.path`,
      )
      .all(revisionId) as { path: string; mode: number; content: Buffer }[];
    const target = join(lib.root_path, name);
    mkdirSync(target);
    for (const file of files) {
      if (
        !file.path ||
        file.path.startsWith("/") ||
        Buffer.byteLength(file.path) > 512 ||
        file.path.split("/").length > 32 ||
        /[\\\0]/.test(file.path) ||
        file.path.split("/").some((p) => !p || p === "." || p === "..")
      )
        throw new SkillError("invalid_path", 400, "Invalid revision path");
      let content = file.content;
      if (file.path === "SKILL.md") {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        if (!match?.[1])
          throw new SkillError("invalid_skill", 400, "Invalid source manifest");
        const doc = parseDocument(match[1], {
          uniqueKeys: true,
          customTags: [],
        });
        if (doc.errors.length)
          throw new SkillError("invalid_skill", 400, "Invalid source manifest");
        doc.set("name", name);
        content = Buffer.from(
          `---\n${doc.toString()}---\n${text.slice(match[0].length)}`,
        );
      }
      const dest = join(target, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content, { flag: "wx", mode: file.mode });
    }
    return this.adopt(
      libraryId,
      name,
      JSON.stringify({
        parent_skill_id: sourceId,
        parent_revision_id: revisionId,
      }),
    );
  }

  create(libraryId: string, name: string, description: string): string {
    if (!validSkillName(name))
      throw new SkillError("invalid_skill", 400, invalidNameMessage(name));
    if (!description.trim() || [...description].length > 1024)
      throw new SkillError(
        "invalid_skill",
        400,
        "Description: enter 1–1,024 characters.",
      );
    const lib = this.db
      .prepare("SELECT root_path FROM skill_libraries WHERE id = ?")
      .get(libraryId) as { root_path: string } | undefined;
    if (!lib) throw new SkillError("unavailable", 404, "Library not found");
    const folder = join(lib.root_path, name);
    mkdirSync(folder);
    const manifest = join(folder, "SKILL.md");
    writeFileSync(
      manifest,
      `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return this.adopt(libraryId, name);
  }

  /**
   * Copies a public skill into a library for an assignment, inside the
   * caller's transaction. Reuses an identical copy, adds a revision to an
   * unmodified copy of the same source, and never overwrites local changes.
   * Working folders are written after the caller commits (finishWorkspaces).
   */
  importPublicForAssignment(
    libraryId: string,
    pack: {
      files: SkillFile[];
      licence: string | null;
      provenance: Record<string, unknown>;
    },
    choice?: { name?: string },
  ): {
    skill_id: string;
    revision_id: string;
    created: "none" | "revision" | "skill";
  } {
    const library = this.db
      .prepare("SELECT root_path FROM skill_libraries WHERE id = ?")
      .get(libraryId) as { root_path: string } | undefined;
    if (!library)
      throw new SkillError("unavailable", 404, "Skill library unavailable");
    const hash = packageHash(pack.files);
    const sameSource = (json: string) => {
      try {
        const value = JSON.parse(json) as Record<string, unknown>;
        return (
          JSON.stringify(value.source) ===
            JSON.stringify(pack.provenance.source) &&
          value.path === pack.provenance.path
        );
      } catch {
        return false;
      }
    };
    const candidates = this.db
      .prepare(
        `SELECT s.id, s.folder_name, s.current_revision_id, r.content_hash, r.provenance_json, r.number
         FROM skills s JOIN skill_revisions r ON r.id = s.current_revision_id
         WHERE s.library_id = ? AND s.trashed_at IS NULL`,
      )
      .all(libraryId) as Array<{
      id: string;
      folder_name: string;
      current_revision_id: string;
      content_hash: string;
      provenance_json: string;
      number: number;
    }>;
    const existing = choice?.name
      ? undefined
      : candidates.find(
          (row) =>
            sameSource(row.provenance_json) ||
            this.db
              .prepare(
                "SELECT 1 FROM skill_revisions WHERE skill_id = ? AND provenance_json = ? LIMIT 1",
              )
              .get(row.id, JSON.stringify(pack.provenance)),
        );
    if (existing) {
      if (existing.content_hash === hash)
        return {
          skill_id: existing.id,
          revision_id: existing.current_revision_id,
          created: "none",
        };
      let draft: boolean;
      try {
        draft =
          packageHash(
            readSkillFiles(join(library.root_path, existing.folder_name)),
          ) !== existing.content_hash;
      } catch {
        draft = existsSync(join(library.root_path, existing.folder_name));
      }
      const provenance = JSON.parse(existing.provenance_json) as Record<
        string,
        unknown
      >;
      // Saving copies provenance forward, so an unmodified copy is one whose
      // content still equals the revision first imported for that commit.
      const imported = this.db
        .prepare(
          "SELECT content_hash FROM skill_revisions WHERE skill_id = ? AND provenance_json = ? ORDER BY number LIMIT 1",
        )
        .get(existing.id, existing.provenance_json) as
        { content_hash: string } | undefined;
      if (
        draft ||
        !sameSource(existing.provenance_json) ||
        provenance.customized ||
        imported?.content_hash !== existing.content_hash
      )
        // Name the exact saved revision, so the page can show it for review if the lead keeps it.
        throw Object.assign(
          new SkillError(
            "local_changes",
            409,
            `${existing.folder_name} has local changes. Keep your version, or add the upstream skill as a separate skill.`,
          ),
          {
            local: {
              skill_id: existing.id,
              revision_id: existing.current_revision_id,
              name: existing.folder_name,
              number: existing.number,
              reviewed: !!this.db
                .prepare("SELECT 1 FROM skill_reviews WHERE revision_id = ?")
                .get(existing.current_revision_id),
              draft,
            },
          },
        );
      const metadata = skillMetadata(pack.files);
      const revision = randomUUID();
      this.insertRevisionRows(
        existing.id,
        revision,
        existing.number + 1,
        pack.files,
        metadata,
        pack.provenance,
        pack.licence,
      );
      this.db
        .prepare("UPDATE skills SET current_revision_id = ? WHERE id = ?")
        .run(revision, existing.id);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO skill_workspace_operations(skill_id, revision_id, state, created_at, previous_revision_id) VALUES (?, ?, 'pending', ?, ?)",
        )
        .run(existing.id, revision, this.now(), existing.current_revision_id);
      return {
        skill_id: existing.id,
        revision_id: revision,
        created: "revision",
      };
    }
    let files = pack.files;
    if (choice?.name) {
      if (!validSkillName(choice.name))
        throw new SkillError(
          "invalid_skill",
          400,
          invalidNameMessage(choice.name),
        );
      files = files.map((file) => {
        if (file.path !== "SKILL.md") return file;
        const text = file.content.toString("utf8");
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        if (!match?.[1]) return file;
        const doc = parseDocument(match[1], {
          uniqueKeys: true,
          customTags: [],
        });
        doc.set("name", choice.name);
        return {
          ...file,
          content: Buffer.from(
            `---\n${doc.toString()}---\n${text.slice(match[0].length)}`,
          ),
        };
      });
    }
    const metadata = skillMetadata(files);
    if (
      existsSync(join(library.root_path, metadata.name)) ||
      this.db
        .prepare(
          "SELECT 1 FROM skills WHERE library_id = ? AND folder_name = ?",
        )
        .get(libraryId, metadata.name)
    )
      throw new SkillError(
        "name_conflict",
        409,
        `A different skill named ${metadata.name} already exists. Choose another name for this copy.`,
      );
    const id = randomUUID();
    const revision = randomUUID();
    this.db
      .prepare(
        "INSERT INTO skills(id, library_id, folder_name, current_revision_id, created_at) VALUES (?, ?, ?, NULL, ?)",
      )
      .run(id, libraryId, metadata.name, this.now());
    this.insertRevisionRows(
      id,
      revision,
      1,
      files,
      metadata,
      pack.provenance,
      pack.licence,
    );
    this.db
      .prepare("UPDATE skills SET current_revision_id = ? WHERE id = ?")
      .run(revision, id);
    this.db
      .prepare(
        "INSERT INTO skill_workspace_operations(skill_id, revision_id, state, created_at) VALUES (?, ?, 'pending', ?)",
      )
      .run(id, revision, this.now());
    return { skill_id: id, revision_id: revision, created: "skill" };
  }

  private insertRevisionRows(
    skillId: string,
    revision: string,
    number: number,
    files: SkillFile[],
    metadata: { name: string; description: string },
    provenance: Record<string, unknown>,
    licence: string | null,
  ): void {
    this.db
      .prepare(
        "INSERT INTO skill_revisions(id, skill_id, number, content_hash, name, description, provenance_json, licence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        revision,
        skillId,
        number,
        packageHash(files),
        metadata.name,
        metadata.description,
        JSON.stringify(provenance),
        licence,
        this.now(),
      );
    const blob = this.db.prepare(
      "INSERT OR IGNORE INTO skill_blobs(hash, content) VALUES (?, ?)",
    );
    const ref = this.db.prepare(
      "INSERT INTO skill_revision_files(revision_id, path, blob_hash, mode) VALUES (?, ?, ?, ?)",
    );
    for (const file of files) {
      const blobHash = createHash("sha256").update(file.content).digest("hex");
      blob.run(blobHash, file.content);
      ref.run(revision, file.path, blobHash, file.mode);
    }
  }

  adopt(
    libraryId: string,
    folder: string,
    provenance = "{}",
    licence: string | null = null,
  ): string {
    if (!validSkillName(folder))
      throw new SkillError("invalid_path", 400, "Invalid skill folder");
    const library = this.db
      .prepare("SELECT root_path FROM skill_libraries WHERE id = ?")
      .get(libraryId) as { root_path: string } | undefined;
    if (!library) throw new SkillError("unavailable", 404, "Library not found");
    if (provenance === "{}" && licence === null) {
      const recovered = this.recoveredDraft(library.root_path, folder);
      if (recovered) ({ provenance, licence } = recovered);
    }
    const files = readSkillFiles(join(library.root_path, folder));
    const metadata = skillMetadata(files);
    if (metadata.name !== folder)
      throw new SkillError("invalid_path", 400, "Skill name must match folder");
    const id = randomUUID();
    const revision = randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO skills(id, library_id, folder_name, current_revision_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, libraryId, folder, revision, this.now());
      this.db
        .prepare(
          "INSERT INTO skill_revisions(id, skill_id, number, content_hash, name, description, provenance_json, licence, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          revision,
          id,
          packageHash(files),
          metadata.name,
          metadata.description,
          provenance,
          licence,
          this.now(),
        );
      const blob = this.db.prepare(
        "INSERT OR IGNORE INTO skill_blobs(hash, content) VALUES (?, ?)",
      );
      const ref = this.db.prepare(
        "INSERT INTO skill_revision_files(revision_id, path, blob_hash, mode) VALUES (?, ?, ?, ?)",
      );
      for (const file of files) {
        const hash = createHash("sha256").update(file.content).digest("hex");
        blob.run(hash, file.content);
        ref.run(revision, file.path, hash, file.mode);
      }
    })();
    return id;
  }
}
