import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  renameSync,
  cpSync,
  readFileSync,
  symlinkSync,
  readdirSync,
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
  it("saves import drafts left by an earlier version as untracked folders, across a restart", () => {
    const home = mkdtempSync(join(tmpdir(), "konfab-drafts-"));
    const root = join(home, "skills");
    mkdirSync(root);
    const path = join(home, "konfab.db");
    try {
      let db = openDatabase(path);
      const libraryId = new SkillLibrary(db).registerLibrary("personal", root);
      // A folder already uses the second draft's name; it must not be overwritten.
      mkdirSync(join(root, "taken"));
      writeFileSync(join(root, "taken", "mine.txt"), "keep");
      const draft = (
        id: string,
        name: string,
        files: Array<[string, string]>,
      ) => {
        db.prepare(
          "INSERT INTO skill_import_drafts(id, library_id, folder_name, provenance_json, licence, diagnostic, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'MIT', 'Description: enter 1–1,024 characters.', 3, 111, 222)",
        ).run(
          id,
          libraryId,
          name,
          JSON.stringify({
            source: { owner: "example", repository: "skills" },
            commit: "c".repeat(40),
            path: `skills/${name}`,
          }),
        );
        for (const [file, content] of files)
          db.prepare(
            "INSERT INTO skill_import_draft_files(draft_id, path, content, mode) VALUES (?, ?, ?, 384)",
          ).run(id, file, Buffer.from(content));
      };
      draft("d1", "half-done", [
        ["SKILL.md", "---\nname: half-done\n---\nmy unsaved edits"],
        ["notes/a.md", "supporting"],
      ]);
      draft("d2", "taken", [["SKILL.md", "---\nname: taken\n---\nother"]]);
      // A crash left a partial staging folder that this recovery owns, and something
      // else uses a similar name without the owner marker.
      mkdirSync(join(root, ".konfab-draft-d1-crashed"));
      writeFileSync(
        join(root, ".konfab-draft-d1-crashed", ".konfab-draft-owner"),
        "d1",
      );
      writeFileSync(join(root, ".konfab-draft-d1-crashed", "partial"), "x");
      mkdirSync(join(root, ".konfab-draft-d1-foreign"));
      writeFileSync(join(root, ".konfab-draft-d1-foreign", "theirs"), "keep");
      mkdirSync(join(root, ".konfab-draft-d1"));
      writeFileSync(join(root, ".konfab-draft-d1", "old"), "keep");
      db.close();

      db = openDatabase(path);
      const library = new SkillLibrary(db);
      expect(readFileSync(join(root, "half-done", "SKILL.md"), "utf8")).toBe(
        "---\nname: half-done\n---\nmy unsaved edits",
      );
      expect(
        readFileSync(join(root, "half-done", "notes", "a.md"), "utf8"),
      ).toBe("supporting");
      expect(existsSync(join(root, "half-done", "partial"))).toBe(false);
      expect(existsSync(join(root, "half-done", ".konfab-draft-owner"))).toBe(
        false,
      );
      // Owned partial removed; unowned folders left alone.
      expect(existsSync(join(root, ".konfab-draft-d1-crashed"))).toBe(false);
      expect(
        readFileSync(join(root, ".konfab-draft-d1-foreign", "theirs"), "utf8"),
      ).toBe("keep");
      expect(readFileSync(join(root, ".konfab-draft-d1", "old"), "utf8")).toBe(
        "keep",
      );
      // The draft's metadata is kept beside the folder, outside the skill files.
      const sidecar = JSON.parse(
        readFileSync(join(root, ".konfab-recovered-drafts", "d1.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(sidecar).toMatchObject({
        recovered_from_draft: "d1",
        original_name: "half-done",
        folder: "half-done",
        provenance: {
          source: { owner: "example", repository: "skills" },
          commit: "c".repeat(40),
          path: "skills/half-done",
        },
        licence: "MIT",
        diagnostic: "Description: enter 1–1,024 characters.",
        revision: 3,
        created_at: 111,
        updated_at: 222,
      });
      expect(readFileSync(join(root, "taken", "mine.txt"), "utf8")).toBe(
        "keep",
      );
      expect(
        readFileSync(join(root, "taken-draft", "SKILL.md"), "utf8"),
      ).toContain("other");
      expect(
        db.prepare("SELECT count(*) AS n FROM skill_import_drafts").get(),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare(
            "SELECT count(*) AS n FROM upgrade_log WHERE kind = 'recovered_draft'",
          )
          .get(),
      ).toEqual({ n: 2 });
      const listed = library.list(libraryId);
      expect(listed.untracked).toEqual(
        expect.arrayContaining(["half-done", "taken-draft"]),
      );
      db.close();
      // Another restart changes nothing.
      db = openDatabase(path);
      new SkillLibrary(db);
      expect(
        readFileSync(join(root, "half-done", "SKILL.md"), "utf8"),
      ).toContain("my unsaved edits");
      db.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps each recovered draft's metadata apart and never replaces files it did not create", () => {
    const home = mkdtempSync(join(tmpdir(), "konfab-drafts-"));
    const root = join(home, "skills");
    mkdirSync(root);
    const sidecars = join(root, ".konfab-recovered-drafts");
    const path = join(home, "konfab.db");
    const twin = "---\nname: twin\ndescription: Same files\n---\nbody";
    try {
      let db = openDatabase(path);
      const libraryId = new SkillLibrary(db).registerLibrary("personal", root);
      const draft = (
        id: string,
        name: string,
        content: string,
        repository: string,
        licence: string,
      ) => {
        db.prepare(
          "INSERT INTO skill_import_drafts(id, library_id, folder_name, provenance_json, licence, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, 0)",
        ).run(
          id,
          libraryId,
          name,
          JSON.stringify({ source: { owner: "example", repository } }),
          licence,
          Number(id.slice(1)),
        );
        db.prepare(
          "INSERT INTO skill_import_draft_files(draft_id, path, content, mode) VALUES (?, 'SKILL.md', ?, 384)",
        ).run(id, Buffer.from(content));
      };
      // Two drafts with identical files but different sources and licences.
      draft("d4", "twin", twin, "first", "MIT");
      draft("d5", "twin", twin, "second", "Apache-2.0");
      // Something unrelated already uses d6's metadata file name.
      draft("d6", "blocked", "---\nname: blocked\n---\nx", "third", "MIT");
      mkdirSync(sidecars);
      writeFileSync(join(sidecars, "d6.json"), "not mine");
      // An earlier start crashed after promoting d7's folder but before unmarking it.
      const resumed = "---\nname: resumed\n---\ny";
      draft("d7", "resumed", resumed, "fourth", "MIT");
      writeFileSync(
        join(sidecars, "d7.json"),
        JSON.stringify({ recovered_from_draft: "d7", folder: "resumed" }),
      );
      mkdirSync(join(root, "resumed"));
      writeFileSync(join(root, "resumed", "SKILL.md"), resumed, {
        mode: 0o600,
      });
      writeFileSync(join(root, "resumed", ".konfab-draft-owner"), "d7");
      // d8 claimed a folder that someone has since replaced with other files.
      draft("d8", "changed", "---\nname: changed\n---\nz", "fifth", "MIT");
      writeFileSync(
        join(sidecars, "d8.json"),
        JSON.stringify({ recovered_from_draft: "d8", folder: "changed" }),
      );
      mkdirSync(join(root, "changed"));
      writeFileSync(join(root, "changed", "SKILL.md"), "theirs");
      db.close();

      db = openDatabase(path);
      const library = new SkillLibrary(db);
      const read = (name: string) =>
        JSON.parse(readFileSync(join(sidecars, name), "utf8")) as Record<
          string,
          unknown
        >;
      expect(read("d4.json")).toMatchObject({
        folder: "twin",
        provenance: { source: { repository: "first" } },
        licence: "MIT",
      });
      expect(read("d5.json")).toMatchObject({
        folder: "twin-draft",
        provenance: { source: { repository: "second" } },
        licence: "Apache-2.0",
      });
      expect(readFileSync(join(root, "twin-draft", "SKILL.md"), "utf8")).toBe(
        twin,
      );
      expect(readFileSync(join(sidecars, "d6.json"), "utf8")).toBe("not mine");
      expect(existsSync(join(root, "blocked"))).toBe(false);
      expect(existsSync(join(root, "resumed", ".konfab-draft-owner"))).toBe(
        false,
      );
      expect(readFileSync(join(root, "resumed", "SKILL.md"), "utf8")).toBe(
        resumed,
      );
      expect(readFileSync(join(root, "changed", "SKILL.md"), "utf8")).toBe(
        "theirs",
      );
      expect(
        db
          .prepare("SELECT id FROM skill_import_drafts ORDER BY id")
          .all()
          .map((row) => (row as { id: string }).id),
      ).toEqual(["d6", "d8"]);
      // Adopting a folder applies the metadata of the draft that created it.
      const adopted = library.detail(library.adopt(libraryId, "twin"));
      expect(JSON.parse(adopted.provenance_json)).toEqual({
        source: { owner: "example", repository: "first" },
        recovered_from_draft: "d4",
      });
      expect(adopted.licence).toBe("MIT");
      db.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps drafts when the metadata folder is a symbolic link", () => {
    const home = mkdtempSync(join(tmpdir(), "konfab-drafts-"));
    const root = join(home, "skills");
    const elsewhere = join(home, "elsewhere");
    mkdirSync(root);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, ".konfab-recovered-drafts"));
    const path = join(home, "konfab.db");
    try {
      let db = openDatabase(path);
      const libraryId = new SkillLibrary(db).registerLibrary("personal", root);
      db.prepare(
        "INSERT INTO skill_import_drafts(id, library_id, folder_name, provenance_json, revision, created_at, updated_at) VALUES ('d9', ?, 'linked', '{}', 1, 0, 0)",
      ).run(libraryId);
      db.prepare(
        "INSERT INTO skill_import_draft_files(draft_id, path, content, mode) VALUES ('d9', 'SKILL.md', ?, 384)",
      ).run(Buffer.from("---\nname: linked\n---\nbody"));
      db.close();
      db = openDatabase(path);
      new SkillLibrary(db);
      expect(existsSync(join(root, "linked"))).toBe(false);
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(
        db.prepare("SELECT count(*) AS n FROM skill_import_drafts").get(),
      ).toEqual({ n: 1 });
      db.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps a draft when its library folder is unavailable, and saves it once the folder is back", () => {
    const home = mkdtempSync(join(tmpdir(), "konfab-drafts-"));
    const root = join(home, "skills");
    mkdirSync(root);
    const path = join(home, "konfab.db");
    try {
      let db = openDatabase(path);
      const libraryId = new SkillLibrary(db).registerLibrary("personal", root);
      db.prepare(
        "INSERT INTO skill_import_drafts(id, library_id, folder_name, provenance_json, revision, created_at, updated_at) VALUES ('d3', ?, 'later', '{}', 1, 0, 0)",
      ).run(libraryId);
      db.prepare(
        "INSERT INTO skill_import_draft_files(draft_id, path, content, mode) VALUES ('d3', 'SKILL.md', ?, 384)",
      ).run(Buffer.from("---\nname: later\n---\nbody"));
      db.close();
      renameSync(root, `${root}-away`);
      db = openDatabase(path);
      new SkillLibrary(db);
      expect(
        db.prepare("SELECT count(*) AS n FROM skill_import_drafts").get(),
      ).toEqual({ n: 1 });
      db.close();
      renameSync(`${root}-away`, root);
      db = openDatabase(path);
      new SkillLibrary(db);
      expect(readFileSync(join(root, "later", "SKILL.md"), "utf8")).toContain(
        "body",
      );
      expect(
        db.prepare("SELECT count(*) AS n FROM skill_import_drafts").get(),
      ).toEqual({ n: 0 });
      db.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("finishes a renamed import journal after reopening", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-import-recover-"));
    const dbPath = join(root, "state.db");
    let db = openDatabase(dbPath);
    try {
      const service = new SkillLibrary(db);
      const library = service.registerLibrary("personal", root);
      const folder = join(root, "recovered");
      mkdirSync(folder);
      writeFileSync(
        join(folder, "SKILL.md"),
        "---\nname: recovered\ndescription: Recovered import\n---\n",
      );
      db.prepare(
        "INSERT INTO skill_import_operations(id, library_id, folder_name, staging_name, provenance_json, licence, state, created_at) VALUES (?, ?, 'recovered', ?, '{}', 'MIT', 'renamed', 0)",
      ).run(randomUUID(), library, `.konfab-import-${randomUUID()}`);
      db.close();
      db = openDatabase(dbPath);
      const reopened = new SkillLibrary(db);
      const listed = reopened.list(library).skills as unknown as Array<{
        name: string;
        licence: string | null;
      }>;
      expect(listed).toEqual([
        expect.objectContaining({ name: "recovered", licence: "MIT" }),
      ]);
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM skill_import_operations")
            .get() as { n: number }
        ).n,
      ).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
