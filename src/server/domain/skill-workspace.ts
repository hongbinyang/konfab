import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/index.js";
import { packageHash, readSkillFiles, type SkillFile } from "./skill-files.js";

/**
 * Writes a skill's working folder from a saved revision, creating only.
 *
 * At the visible path `<library>/<name>` Konfab only creates: the folder with
 * an exclusive mkdir and each file with an exclusive open. It never renames
 * onto that path, so no existing folder, file or link (empty or not) is ever
 * replaced. A previous folder is moved into a private holding folder created
 * exclusively for it and kept until the lead removes it. Each step is
 * recorded, so a restart resumes where it stopped. See
 * docs/design/local-skill-import.md.
 *
 * Remaining limit: Node has no openat, so between the inode check and a file
 * create, another process could swap the claimed folder for its own; Konfab
 * would then add (never replace) a file there, and verify reports it.
 */

export const WRITING_MARKER = ".konfab-writing";
export const KEPT_ROOT = ".konfab-previous";

export type PendingCode = "folder_exists" | "folder_edited" | "write_failed";
export interface PendingReason {
  code: PendingCode;
  folder: string;
  detail: string;
}
export type WorkspaceResult =
  { folder: "ready" } | { folder: "pending"; pending_reason: PendingReason };

type Step = "check" | "aside" | "claim" | "write" | "verify" | "done";

interface Operation {
  skill_id: string;
  revision_id: string;
  previous_revision_id: string | null;
  step: Step | null;
  claim_dev: string | null;
  claim_ino: string | null;
  kept_path: string | null;
  created_dirs_json: string | null;
  folder_name: string;
  library_id: string;
  root_path: string;
  content_hash: string;
  previous_hash: string | null;
}

/** Test seam: called after each step, so tests can simulate a crash or a race there. */
export const workspaceHooks: {
  afterStep?: (step: Step, skillId: string) => void;
  beforeFile?: (path: string, skillId: string) => void;
} = {};

class Pending extends Error {
  constructor(readonly reason: PendingReason) {
    super(reason.detail);
  }
}

function realDirectory(path: string): Stats | null {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

/** The package in a folder, without Konfab's own writing marker. */
export function folderHash(folder: string): string {
  return packageHash(
    readSkillFiles(folder).filter((file) => file.path !== WRITING_MARKER),
  );
}

export class SkillWorkspace {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  private operation(skillId: string): Operation | undefined {
    return this.db
      .prepare(
        `SELECT o.skill_id, o.revision_id, o.previous_revision_id, o.step, o.claim_dev, o.claim_ino, o.kept_path,
           o.created_dirs_json, s.folder_name, s.library_id, l.root_path, r.content_hash, p.content_hash AS previous_hash
         FROM skill_workspace_operations o JOIN skills s ON s.id = o.skill_id JOIN skill_libraries l ON l.id = s.library_id
         JOIN skill_revisions r ON r.id = o.revision_id LEFT JOIN skill_revisions p ON p.id = o.previous_revision_id
         WHERE o.skill_id = ? AND o.state = 'pending'`,
      )
      .get(skillId) as Operation | undefined;
  }

  private record(skillId: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    this.db
      .prepare(
        `UPDATE skill_workspace_operations SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE skill_id = ?`,
      )
      .run(...keys.map((key) => fields[key]), skillId);
  }

  private files(revisionId: string): SkillFile[] {
    return this.db
      .prepare(
        "SELECT f.path, f.mode, b.content FROM skill_revision_files f JOIN skill_blobs b ON b.hash = f.blob_hash WHERE f.revision_id = ? ORDER BY f.path",
      )
      .all(revisionId) as SkillFile[];
  }

  /** Runs every pending operation; used at startup. */
  runAll(): void {
    const ids = this.db
      .prepare(
        "SELECT skill_id FROM skill_workspace_operations WHERE state = 'pending'",
      )
      .all() as Array<{ skill_id: string }>;
    for (const { skill_id } of ids) this.run(skill_id);
  }

  /** The current pending reason for a skill's folder, if any. */
  reason(skillId: string): PendingReason | null {
    const row = this.db
      .prepare(
        "SELECT reason_json FROM skill_workspace_operations WHERE skill_id = ? AND state = 'pending'",
      )
      .get(skillId) as { reason_json: string | null } | undefined;
    if (!row) return null;
    return row.reason_json
      ? (JSON.parse(row.reason_json) as PendingReason)
      : {
          code: "write_failed",
          folder: "",
          detail: "The folder hasn't been written yet.",
        };
  }

  /** Writes or resumes writing a skill's folder; never throws for file system problems. */
  run(skillId: string): WorkspaceResult {
    const op = this.operation(skillId);
    if (!op) return { folder: "ready" };
    try {
      this.advance(op);
      this.db
        .prepare(
          "UPDATE skill_workspace_operations SET state = 'complete', step = 'done', reason_json = NULL WHERE skill_id = ?",
        )
        .run(skillId);
      return { folder: "ready" };
    } catch (error) {
      const reason =
        error instanceof Pending
          ? error.reason
          : {
              code: "write_failed" as const,
              folder: op.folder_name,
              detail: `Couldn't write to the library folder: ${(error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? "unknown error"}.`,
            };
      this.record(skillId, { reason_json: JSON.stringify(reason) });
      return { folder: "pending", pending_reason: reason };
    }
  }

  private advance(op: Operation): void {
    if (!realDirectory(op.root_path))
      throw new Pending({
        code: "write_failed",
        folder: op.folder_name,
        detail: "The library folder is missing or isn't a real folder.",
      });
    const folder = join(op.root_path, op.folder_name);
    const opId = `${op.skill_id}:${op.revision_id}`;
    const exists = (path: string) => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    };
    const ours = () => {
      const stat = realDirectory(folder);
      if (
        !stat ||
        op.claim_ino === null ||
        String(stat.ino) !== op.claim_ino ||
        String(stat.dev) !== op.claim_dev
      )
        return false;
      try {
        const marker = lstatSync(join(folder, WRITING_MARKER));
        return (
          marker.isFile() &&
          readFileSync(join(folder, WRITING_MARKER), "utf8") === opId
        );
      } catch {
        return false;
      }
    };
    const exists_ = () =>
      new Pending({
        code: "folder_exists",
        folder: op.folder_name,
        detail: `A folder or file named ${op.folder_name} is in the library, and it isn't this skill's. Konfab didn't change it.`,
      });
    const edited = (detail?: string) =>
      new Pending({
        code: "folder_edited",
        folder: op.folder_name,
        detail:
          detail ??
          `${op.folder_name} was edited after Konfab checked it, so Konfab didn't replace it.`,
      });
    const set = (step: Step, fields: Record<string, unknown> = {}) => {
      op.step = step;
      this.record(op.skill_id, { step, ...fields });
      workspaceHooks.afterStep?.(step, op.skill_id);
    };
    const hashOf = (path: string) => {
      try {
        return realDirectory(path) ? folderHash(path) : null;
      } catch {
        return null;
      }
    };

    let step: Step = op.step ?? "check";
    if (step === "check") {
      if (!exists(folder)) set("claim");
      else {
        const hash = hashOf(folder);
        if (hash === op.content_hash && !exists(join(folder, WRITING_MARKER)))
          return;
        if (op.previous_hash && hash === op.previous_hash) set("aside");
        else throw op.previous_hash ? edited() : exists_();
      }
      step = op.step as Step;
    }
    if (step === "aside") {
      const keptRoot = join(op.root_path, KEPT_ROOT);
      let kept = op.kept_path;
      if (!kept) {
        if (!exists(keptRoot)) mkdirSync(keptRoot, { mode: 0o700 });
        if (!realDirectory(keptRoot))
          throw new Pending({
            code: "write_failed",
            folder: op.folder_name,
            detail: `${KEPT_ROOT} in the library isn't a real folder.`,
          });
        const holder = join(keptRoot, randomUUID());
        mkdirSync(holder, { mode: 0o700 });
        kept = join(holder, op.folder_name);
        op.kept_path = kept;
        this.record(op.skill_id, { kept_path: kept });
      }
      if (exists(folder) && !exists(kept)) {
        if (hashOf(folder) !== op.previous_hash) throw edited();
        renameSync(folder, kept);
        this.db
          .prepare(
            "INSERT INTO skill_kept_folders(id, skill_id, library_id, revision_id, path, kind, created_at) VALUES (?, ?, ?, ?, ?, 'previous', ?)",
          )
          .run(
            randomUUID(),
            op.skill_id,
            op.library_id,
            op.previous_revision_id,
            kept,
            this.now(),
          );
      }
      set("claim");
      step = "claim";
    }
    if (step === "claim") {
      const stat = realDirectory(folder);
      if (
        stat &&
        String(stat.ino) === op.claim_ino &&
        String(stat.dev) === op.claim_dev &&
        !exists(join(folder, WRITING_MARKER)) &&
        readdirSync(folder).length === 0
      )
        // Crashed between claiming and marking: the empty folder is the one this operation created.
        writeFileSync(join(folder, WRITING_MARKER), opId, {
          flag: "wx",
          mode: 0o600,
        });
      else if (exists(folder)) {
        if (!ours()) throw exists_();
      } else {
        mkdirSync(folder, { mode: 0o755 });
        const stat = lstatSync(folder);
        op.claim_dev = String(stat.dev);
        op.claim_ino = String(stat.ino);
        this.record(op.skill_id, {
          claim_dev: op.claim_dev,
          claim_ino: op.claim_ino,
          created_dirs_json: "[]",
        });
        writeFileSync(join(folder, WRITING_MARKER), opId, {
          flag: "wx",
          mode: 0o600,
        });
      }
      set("write");
      step = "write";
    }
    if (step === "write") {
      if (!ours()) throw exists_();
      const created = new Set<string>(
        JSON.parse(op.created_dirs_json ?? "[]") as string[],
      );
      for (const file of this.files(op.revision_id)) {
        workspaceHooks.beforeFile?.(file.path, op.skill_id);
        if (!ours()) throw exists_();
        const parts = file.path.split("/");
        // Every directory on the way must be one this operation created, never a link.
        for (let i = 1; i < parts.length; i += 1) {
          const relative = parts.slice(0, i).join("/");
          const path = join(folder, relative);
          if (!exists(path)) {
            mkdirSync(path, { mode: 0o755 });
            created.add(relative);
            this.record(op.skill_id, {
              created_dirs_json: JSON.stringify([...created]),
            });
          } else if (!realDirectory(path) || !created.has(relative))
            throw edited(
              `${op.folder_name}/${relative} changed while Konfab was writing it, so Konfab stopped.`,
            );
        }
        const destination = join(folder, file.path);
        if (exists(destination)) {
          const stat = lstatSync(destination);
          if (
            !stat.isFile() ||
            !readFileSync(destination).equals(file.content) ||
            (stat.mode & 0o777) !== file.mode
          )
            throw edited(
              `${op.folder_name}/${file.path} changed while Konfab was writing it, so Konfab stopped.`,
            );
          continue;
        }
        writeFileSync(destination, file.content, {
          flag: "wx",
          mode: file.mode,
        });
        chmodSync(destination, file.mode); // not narrowed by the umask
      }
      set("verify");
      step = "verify";
    }
    if (step === "verify") {
      if (!ours()) throw exists_();
      if (hashOf(folder) !== op.content_hash)
        throw edited(
          `${op.folder_name} changed while Konfab was writing it, so Konfab stopped.`,
        );
      unlinkSync(join(folder, WRITING_MARKER));
      return;
    }
  }

  /**
   * Moves whatever is at the skill's folder path into a kept folder, so the
   * pending write can continue. Only for a pending operation whose reason is
   * still `expected`.
   */
  moveAside(skillId: string, expected: PendingCode): WorkspaceResult {
    const op = this.operation(skillId);
    const reason = this.reason(skillId);
    if (!op || reason?.code !== expected)
      throw Object.assign(new Error("This changed; review again."), {
        code: "import_changed",
      });
    const folder = join(op.root_path, op.folder_name);
    const keptRoot = join(op.root_path, KEPT_ROOT);
    if (!existsSync(keptRoot)) mkdirSync(keptRoot, { mode: 0o700 });
    if (!realDirectory(keptRoot))
      throw new Error(`${KEPT_ROOT} isn't a folder`);
    const holder = join(keptRoot, randomUUID());
    mkdirSync(holder, { mode: 0o700 });
    const kept = join(holder, op.folder_name);
    renameSync(folder, kept);
    this.db
      .prepare(
        "INSERT INTO skill_kept_folders(id, skill_id, library_id, revision_id, path, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        op.skill_id,
        op.library_id,
        op.previous_revision_id,
        kept,
        expected === "folder_edited" ? "edits" : "other",
        this.now(),
      );
    this.record(skillId, {
      step: "claim",
      claim_dev: null,
      claim_ino: null,
      created_dirs_json: null,
      reason_json: null,
    });
    return this.run(skillId);
  }
}
