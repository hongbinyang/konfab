import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  renameSync,
  cpSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/index.js";
import {
  packageHash,
  readSkillFiles,
} from "../../src/server/domain/skill-files.js";
import { SkillLibrary } from "../../src/server/domain/skills.js";

describe("skill library adoption", () => {
  it("persists content-addressed snapshots after reopening the database", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-library-"));
    try {
      const folder = join(root, "example");
      mkdirSync(folder);
      writeFileSync(
        join(folder, "SKILL.md"),
        "---\nname: example\ndescription: Example\n---\nBody",
      );
      writeFileSync(join(folder, "a"), "identical");
      writeFileSync(join(folder, "b"), "identical");
      const dbPath = join(root, "app.db");
      let db = openDatabase(dbPath);
      const library = new SkillLibrary(db);
      const libId = library.registerLibrary("project", root);
      expect(library.list(libId).untracked).toContain("example");
      const id = library.adopt(libId, "example");
      expect(library.list(libId).untracked).not.toContain("example");
      const old = db
        .prepare("SELECT current_revision_id FROM skills WHERE id = ?")
        .get(id) as { current_revision_id: string };
      const originalHash = packageHash(readSkillFiles(folder));
      expect(() =>
        library.writeFile(
          id,
          "../escape",
          Buffer.from("bad"),
          old.current_revision_id,
          originalHash,
        ),
      ).toThrow();
      library.writeFile(
        id,
        "a",
        Buffer.from("changed"),
        old.current_revision_id,
        originalHash,
      );
      expect(() =>
        library.writeFile(
          id,
          "a",
          Buffer.from("lost"),
          old.current_revision_id,
          originalHash,
        ),
      ).toThrow("Draft conflict");
      expect(() =>
        library.save(id, old.current_revision_id, originalHash),
      ).toThrow("Draft conflict");
      const currentHash = packageHash(readSkillFiles(folder));
      const newer = library.save(id, old.current_revision_id, currentHash);
      expect(() =>
        library.save(id, old.current_revision_id, currentHash),
      ).toThrow("Revision conflict");
      expect(newer).not.toBe(old.current_revision_id);
      library.markReviewed(id, old.current_revision_id);
      db.prepare(
        "INSERT INTO skill_usages(skill_id, revision_id, owner_type, owner_id, label) VALUES (?, ?, 'role', 'r1', 'Reviewer')",
      ).run(id, old.current_revision_id);
      expect(() => library.trash(id, newer, currentHash)).toThrow("Reviewer");
      db.prepare("DELETE FROM skill_usages WHERE skill_id = ?").run(id);
      library.trash(id, newer, currentHash);
      rmSync(folder, { recursive: true });
      expect(library.detail(id).draft_error).toBeTruthy();
      expect(library.revisions(id)).toHaveLength(2);
      db.close();
      db = openDatabase(dbPath);
      const reopened = new SkillLibrary(db);
      expect(reopened.revisions(id)).toHaveLength(2);
      expect(
        db.prepare("SELECT folder_name FROM skills WHERE id = ?").get(id),
      ).toEqual({ folder_name: "example" });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM skill_revision_files").get(),
      ).toEqual({ n: 6 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM skill_blobs").get()).toEqual(
        { n: 3 },
      );
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM skill_reviews").get(),
      ).toEqual({ n: 1 });
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("duplicates a pinned revision with provenance and retained files", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-copy-"));
    const db = openDatabase(":memory:");
    try {
      const service = new SkillLibrary(db);
      const library = service.registerLibrary("personal", root);
      const source = service.create(library, "source", "Original");
      const revision = (
        db
          .prepare("SELECT current_revision_id FROM skills WHERE id = ?")
          .get(source) as { current_revision_id: string }
      ).current_revision_id;
      const copy = service.duplicate(source, revision, library, "copy");
      const detail = service.detail(copy);
      expect(detail.name).toBe("copy");
      const saved = db
        .prepare("SELECT provenance_json FROM skill_revisions WHERE id = ?")
        .get(detail.current_revision_id) as { provenance_json: string };
      expect(JSON.parse(saved.provenance_json)).toEqual({
        parent_skill_id: source,
        parent_revision_id: revision,
      });
      expect(detail.reviewed_at).toBeNull();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("renames a skill without changing its identity and rejects collisions", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-rename-"));
    const db = openDatabase(":memory:");
    try {
      const service = new SkillLibrary(db);
      const lib = service.registerLibrary("personal", root);
      const id = service.create(lib, "original", "Example");
      const detail = service.detail(id);
      mkdirSync(join(root, "occupied"));
      expect(() =>
        service.rename(
          id,
          "occupied",
          detail.current_revision_id,
          detail.draft_hash!,
        ),
      ).toThrow();
      expect(existsSync(join(root, "occupied"))).toBe(true);
      const revision = service.rename(
        id,
        "renamed",
        detail.current_revision_id,
        detail.draft_hash!,
      );
      expect(service.detail(id).name).toBe("renamed");
      expect(service.detail(id).current_revision_id).toBe(revision);
      expect(existsSync(join(root, "original"))).toBe(false);
      expect(service.revisions(id)).toHaveLength(2);
      const renamed = service.detail(id);
      const restored = service.restoreRevision(
        id,
        detail.current_revision_id,
        renamed.current_revision_id,
        renamed.draft_hash!,
      );
      expect(service.detail(id).current_revision_id).toBe(restored);
      expect(service.detail(id).name).toBe("renamed");
      expect(service.revisions(id)).toHaveLength(3);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted rename after reopening the database", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-recover-"));
    const dbPath = join(root, "state.db");
    let db = openDatabase(dbPath);
    try {
      const service = new SkillLibrary(db);
      const lib = service.registerLibrary("personal", root);
      const id = service.create(lib, "original", "Example");
      const detail = service.detail(id);
      const old = join(root, "original"),
        backup = join(root, `.konfab-backup-${id}`),
        dest = join(root, "other");
      cpSync(old, dest, { recursive: true });
      db.prepare(
        "INSERT INTO skill_rename_operations(skill_id, old_name, new_name, old_hash, new_hash, state, owns_destination, created_at) VALUES (?, 'original', 'other', ?, ?, 'prepared', 1, 0)",
      ).run(id, detail.draft_hash, detail.draft_hash);
      renameSync(old, backup);
      db.close();
      db = openDatabase(dbPath);
      new SkillLibrary(db);
      expect(existsSync(old)).toBe(true);
      expect(existsSync(backup)).toBe(false);
      expect(existsSync(dest)).toBe(false);
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM skill_rename_operations")
            .get() as { n: number }
        ).n,
      ).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("rolls back an interrupted history restore after reopening", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-restore-"));
    const dbPath = join(root, "state.db");
    let db = openDatabase(dbPath);
    try {
      const service = new SkillLibrary(db);
      const lib = service.registerLibrary("personal", root);
      const id = service.create(lib, "example", "Old");
      const old = join(root, "example"),
        backup = join(root, `.konfab-backup-${id}`),
        stage = join(root, `.konfab-restore-${id}`);
      const originalHash = service.detail(id).draft_hash!;
      cpSync(old, stage, { recursive: true });
      writeFileSync(
        join(stage, "SKILL.md"),
        "---\nname: example\ndescription: New\n---\n",
      );
      const newHash = packageHash(readSkillFiles(stage));
      db.prepare(
        "INSERT INTO skill_rename_operations(skill_id, old_name, new_name, old_hash, new_hash, state, owns_destination, created_at) VALUES (?, 'example', 'example', ?, ?, 'prepared', 1, 0)",
      ).run(id, originalHash, newHash);
      renameSync(old, backup);
      renameSync(stage, old);
      db.close();
      db = openDatabase(dbPath);
      const reopened = new SkillLibrary(db);
      expect(reopened.detail(id).draft_hash).toBe(originalHash);
      expect(existsSync(backup)).toBe(false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("cleans only recorded unchanged stale temporary files", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-temp-"));
    const db = openDatabase(":memory:");
    try {
      const service = new SkillLibrary(db, () => 100000000);
      const lib = service.registerLibrary("personal", root);
      const id = randomUUID(),
        modified = randomUUID(),
        untracked = randomUUID();
      writeFileSync(join(root, `.konfab-tmp-${id}`), "expected");
      writeFileSync(join(root, `.konfab-tmp-${modified}`), "changed");
      writeFileSync(join(root, `.konfab-tmp-${untracked}`), "untracked");
      const digest = createHash("sha256").update("expected").digest("hex");
      db.prepare(
        "INSERT INTO skill_temp_files(id, library_id, content_hash, created_at) VALUES (?, ?, ?, 0)",
      ).run(id, lib, digest);
      db.prepare(
        "INSERT INTO skill_temp_files(id, library_id, content_hash, created_at) VALUES (?, ?, ?, 0)",
      ).run(modified, lib, digest);
      new SkillLibrary(db, () => 100000000);
      expect(existsSync(join(root, `.konfab-tmp-${id}`))).toBe(false);
      expect(existsSync(join(root, `.konfab-tmp-${modified}`))).toBe(true);
      expect(existsSync(join(root, `.konfab-tmp-${untracked}`))).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
