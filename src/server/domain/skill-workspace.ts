import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  writeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
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
 * Inside its claim, every subfolder and file is journaled before it is
 * created and identified (dev:ino) right after; recovery reuses only what it
 * can identify, and anything else stays pending for the lead.
 *
 * Remaining limit: Node has no openat, so between the inode check and a file
 * create, another process could swap the claimed folder for its own; Konfab
 * would then add (never replace) a file there, and verify reports it.
 */

export const WRITING_MARKER = ".konfab-writing";

/**
 * Skill folders are written only where the platform can refuse to follow a
 * link when opening (O_NOFOLLOW). Elsewhere (Windows) writes fail closed
 * rather than use a weaker check.
 */
export const SKILL_WRITES_SUPPORTED =
  typeof (constants as Record<string, unknown>).O_NOFOLLOW === "number";
export const SKILL_WRITES_UNSUPPORTED =
  "Skill folder writes aren't supported on this platform yet.";
export const KEPT_ROOT = ".konfab-previous";

export type PendingCode = "folder_exists" | "folder_edited" | "write_failed";
export interface PendingReason {
  code: PendingCode;
  folder: string;
  detail: string;
  /** What was at the folder path when this was reported; Move aside requires it unchanged. */
  target?: string | null;
}

/** The identity of whatever is at a path: kind, device, inode and contents. */
export function targetIdentity(path: string): string | null {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  const kind = stat.isSymbolicLink()
    ? "link"
    : stat.isDirectory()
      ? "dir"
      : stat.isFile()
        ? "file"
        : "other";
  let contents = `${stat.size}:${stat.mtimeMs}`;
  if (kind === "dir")
    try {
      contents = folderHash(path);
    } catch {
      contents = "unreadable";
    }
  return `${kind}:${stat.dev}:${stat.ino}:${contents}`;
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
  writing_file: string | null;
  writing_id: string | null;
  folder_name: string;
  library_id: string;
  root_path: string;
  content_hash: string;
  previous_hash: string | null;
}

/** Test seam: called after each step, so tests can simulate a crash or a race there. */
export const workspaceHooks: {
  afterStep?: (step: Step, skillId: string) => void;
  /** Called inside the Save-my-edits transaction, before it commits. */
  inSaveEdits?: (skillId: string) => void;
  /** Called right after each file system change, before the journal records what follows. */
  afterFs?: (label: string, skillId: string) => void;
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
           o.created_dirs_json, o.writing_file, o.writing_id, s.folder_name, s.library_id, l.root_path, r.content_hash, p.content_hash AS previous_hash
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
      if (reason.code !== "write_failed")
        reason.target = targetIdentity(join(op.root_path, op.folder_name));
      this.record(skillId, { reason_json: JSON.stringify(reason) });
      return { folder: "pending", pending_reason: reason };
    }
  }

  private advance(op: Operation): void {
    if (!SKILL_WRITES_SUPPORTED)
      throw new Pending({
        code: "write_failed",
        folder: op.folder_name,
        detail: SKILL_WRITES_UNSUPPORTED,
      });
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

    // Journal first: every file system change is recorded before it is made,
    // so a crash between the two leaves a state the next run recognises.
    const fs = (label: string) => workspaceHooks.afterFs?.(label, op.skill_id);
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
      if (!exists(keptRoot)) {
        mkdirSync(keptRoot, { mode: 0o700 });
        fs("kept-root");
      }
      if (!realDirectory(keptRoot))
        throw new Pending({
          code: "write_failed",
          folder: op.folder_name,
          detail: `${KEPT_ROOT} in the library isn't a real folder.`,
        });
      let kept = op.kept_path;
      if (!kept) {
        kept = join(keptRoot, randomUUID(), op.folder_name);
        const path = kept;
        this.db.transaction(() => {
          this.record(op.skill_id, { kept_path: path });
          this.db
            .prepare(
              "INSERT INTO skill_kept_folders(id, skill_id, library_id, revision_id, path, kind, created_at) VALUES (?, ?, ?, ?, ?, 'previous', ?)",
            )
            .run(
              randomUUID(),
              op.skill_id,
              op.library_id,
              op.previous_revision_id,
              path,
              this.now(),
            );
        })();
        op.kept_path = kept;
      }
      const holder = dirname(kept);
      if (!exists(holder)) {
        mkdirSync(holder, { mode: 0o700 });
        fs("holder");
      }
      if (!realDirectory(holder))
        throw new Pending({
          code: "write_failed",
          folder: op.folder_name,
          detail: `Konfab's holding folder for ${op.folder_name} isn't a real folder.`,
        });
      if (exists(folder) && !exists(kept)) {
        if (hashOf(folder) !== op.previous_hash) {
          // Nothing was moved: forget the planned kept copy.
          this.db.transaction(() => {
            this.db
              .prepare("DELETE FROM skill_kept_folders WHERE path = ?")
              .run(kept);
            this.record(op.skill_id, { kept_path: null, step: "check" });
          })();
          try {
            rmdirSync(holder);
          } catch {
            /* Not empty or already gone: leave it. */
          }
          throw edited();
        }
        renameSync(folder, kept);
        fs("aside");
      } else if (!exists(folder) && !exists(kept))
        // The old folder was removed by someone else: there is nothing to keep.
        this.db
          .prepare("DELETE FROM skill_kept_folders WHERE path = ?")
          .run(kept);
      set("claim");
      step = "claim";
    }
    if (step === "claim") {
      const stat = realDirectory(folder);
      const claimed =
        stat &&
        op.claim_ino !== null &&
        String(stat.ino) === op.claim_ino &&
        String(stat.dev) === op.claim_dev;
      if (claimed && !exists(join(folder, WRITING_MARKER))) {
        if (readdirSync(folder).length !== 0) throw exists_();
        // Crashed between recording the claim and marking it.
        writeFileSync(join(folder, WRITING_MARKER), opId, {
          flag: "wx",
          mode: 0o600,
        });
        fs("marker");
      } else if (claimed) {
        if (!ours()) throw exists_();
      } else if (exists(folder)) {
        if (stat && op.claim_ino === null && readdirSync(folder).length === 0)
          throw new Pending({
            code: "folder_exists",
            folder: op.folder_name,
            detail: `An empty folder named ${op.folder_name} is in the library. Konfab may have created it just before it stopped, but can't prove it, so it didn't use it. Move it aside to continue.`,
          });
        throw exists_();
      } else {
        this.record(op.skill_id, {
          claim_dev: null,
          claim_ino: null,
          created_dirs_json: "{}",
          writing_file: null,
          writing_id: null,
        });
        mkdirSync(folder, { mode: 0o755 });
        fs("claim");
        const made = lstatSync(folder);
        op.claim_dev = String(made.dev);
        op.claim_ino = String(made.ino);
        op.created_dirs_json = "{}";
        this.record(op.skill_id, {
          claim_dev: op.claim_dev,
          claim_ino: op.claim_ino,
        });
        writeFileSync(join(folder, WRITING_MARKER), opId, {
          flag: "wx",
          mode: 0o600,
        });
        fs("marker");
      }
      set("write");
      step = "write";
    }
    if (step === "write") {
      if (!ours()) throw exists_();
      // What this operation created inside its claim, by identity: a path is
      // recorded before it is created (null) and its dev:ino right after.
      const parsed = JSON.parse(op.created_dirs_json ?? "{}") as unknown;
      const created: Record<string, string | null> =
        parsed && !Array.isArray(parsed)
          ? (parsed as Record<string, string | null>)
          : {};
      const identity = (stat: Stats) => `${stat.dev}:${stat.ino}`;
      const unproven = (path: string) =>
        edited(
          `${op.folder_name}/${path} is there, and Konfab may have created it just before it stopped, but can't prove it, so it didn't use it. Move the folder aside to continue.`,
        );
      const create = (file: SkillFile, destination: string) => {
        try {
          this.writeFile(op, destination, file, fs);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw unproven(file.path);
          throw error;
        }
      };
      for (const file of this.files(op.revision_id)) {
        workspaceHooks.beforeFile?.(file.path, op.skill_id);
        if (!ours()) throw exists_();
        const parts = file.path.split("/");
        // Every directory on the way must be one this operation created, never a link.
        for (let i = 1; i < parts.length; i += 1) {
          const relative = parts.slice(0, i).join("/");
          const path = join(folder, relative);
          if (!exists(path)) {
            created[relative] = null;
            op.created_dirs_json = JSON.stringify(created);
            this.record(op.skill_id, {
              created_dirs_json: op.created_dirs_json,
            });
            fs("journal-dir");
            try {
              mkdirSync(path, { mode: 0o755 });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST")
                throw unproven(relative);
              throw error;
            }
            fs("mkdir");
            created[relative] = identity(lstatSync(path));
            op.created_dirs_json = JSON.stringify(created);
            this.record(op.skill_id, {
              created_dirs_json: op.created_dirs_json,
            });
            continue;
          }
          const stat = realDirectory(path);
          if (stat && created[relative] === identity(stat)) continue;
          if (relative in created) throw unproven(relative);
          throw edited(
            `${op.folder_name}/${relative} changed while Konfab was writing it, so Konfab stopped.`,
          );
        }
        const destination = join(folder, file.path);
        if (exists(destination)) {
          const stat = lstatSync(destination);
          const current = stat.isFile() ? readFileSync(destination) : null;
          if (
            current?.equals(file.content) &&
            (stat.mode & 0o777) === file.mode
          )
            continue;
          // The file this operation was writing when it stopped. It is accepted
          // only if already complete (above, or here when only its mode was not
          // yet set); an incomplete file is never finished automatically, since
          // another writer could be appending to it. The lead moves it aside.
          if (
            op.writing_file === file.path &&
            op.writing_id !== null &&
            op.writing_id === identity(stat) &&
            current !== null
          ) {
            if (current.equals(file.content)) {
              this.setMode(op, destination, file);
              continue;
            }
            throw edited(
              `${op.folder_name}/${file.path} is incomplete because Konfab's write was interrupted. Konfab kept it as it is; move the folder aside to write it again.`,
            );
          }
          if (op.writing_file === file.path) throw unproven(file.path);
          throw edited(
            `${op.folder_name}/${file.path} changed while Konfab was writing it, so Konfab stopped.`,
          );
        }
        create(file, destination);
      }
      set("verify", { writing_file: null, writing_id: null });
      step = "verify";
    }
    if (step === "verify") {
      const stat = realDirectory(folder);
      const claimed =
        stat &&
        String(stat.ino) === op.claim_ino &&
        String(stat.dev) === op.claim_dev;
      if (!claimed) throw exists_();
      if (hashOf(folder) !== op.content_hash)
        throw edited(
          `${op.folder_name} changed while Konfab was writing it, so Konfab stopped.`,
        );
      // Without the marker, a matching claimed folder means only the final journal write was lost.
      if (ours()) {
        unlinkSync(join(folder, WRITING_MARKER));
        fs("unmark");
      }
      return;
    }
  }

  /** Sets the mode of a complete file this operation created, after checking it is still that file. */
  private setMode(op: Operation, destination: string, file: SkillFile): void {
    const fd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (`${stat.dev}:${stat.ino}` !== op.writing_id)
        throw new Pending({
          code: "folder_edited",
          folder: op.folder_name,
          detail: `${op.folder_name}/${file.path} changed while Konfab was writing it, so Konfab stopped.`,
        });
      fchmodSync(fd, file.mode);
    } finally {
      closeSync(fd);
    }
  }

  /** Creates one file exclusively, recording its path first and its identity right after. */
  private writeFile(
    op: Operation,
    destination: string,
    file: SkillFile,
    fs: (label: string) => void,
  ): void {
    op.writing_file = file.path;
    op.writing_id = null;
    this.record(op.skill_id, { writing_file: file.path, writing_id: null });
    fs("journal-file");
    const fd = openSync(
      destination,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      file.mode,
    );
    try {
      fs("file-open");
      const stat = fstatSync(fd);
      op.writing_id = `${stat.dev}:${stat.ino}`;
      this.record(op.skill_id, { writing_id: op.writing_id });
      writeSync(fd, file.content);
      fs("file");
      fchmodSync(fd, file.mode); // not narrowed by the umask
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Moves whatever is at the skill's folder path into a kept folder, so the
   * pending write can continue. Only for a pending operation whose reason is
   * still `expected`.
   */
  moveAside(
    skillId: string,
    expected: PendingCode,
    expectedTarget: string | null,
  ): WorkspaceResult {
    const op = this.operation(skillId);
    const reason = this.reason(skillId);
    // The lead confirmed moving a specific thing: it must still be exactly that.
    if (
      !op ||
      reason?.code !== expected ||
      !reason.target ||
      reason.target !== expectedTarget ||
      targetIdentity(join(op.root_path, op.folder_name)) !== reason.target
    )
      throw Object.assign(new Error("This changed; review again."), {
        code: "import_changed",
      });
    const folder = join(op.root_path, op.folder_name);
    const keptRoot = join(op.root_path, KEPT_ROOT);
    if (!existsSync(keptRoot)) mkdirSync(keptRoot, { mode: 0o700 });
    if (!realDirectory(keptRoot))
      throw new Error(`${KEPT_ROOT} isn't a folder`);
    const kept = join(keptRoot, randomUUID(), op.folder_name);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO skill_kept_folders(id, skill_id, library_id, revision_id, path, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        op.skill_id,
        op.library_id,
        op.previous_revision_id,
        kept,
        expected === "folder_edited" ? "edits" : "other",
        this.now(),
      );
    try {
      mkdirSync(dirname(kept), { mode: 0o700 });
      renameSync(folder, kept);
    } catch (error) {
      this.db.prepare("DELETE FROM skill_kept_folders WHERE id = ?").run(id);
      try {
        rmdirSync(dirname(kept));
      } catch {
        /* Not created or not empty. */
      }
      throw error;
    }
    this.record(skillId, {
      step: "claim",
      claim_dev: null,
      claim_ino: null,
      created_dirs_json: null,
      writing_file: null,
      writing_id: null,
      reason_json: null,
    });
    return this.run(skillId);
  }
}
