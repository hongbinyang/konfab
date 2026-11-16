import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { normalizeUpload } from "../../src/server/domain/local-import.js";
import { SkillLibrary } from "../../src/server/domain/skills.js";
import {
  KEPT_ROOT,
  workspaceHooks,
} from "../../src/server/domain/skill-workspace.js";

const manifest = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Designs things\n${extra}---\n\nBody of ${name}\n`;
const upload = (
  files: Record<string, string>,
  options: {
    single?: boolean;
    skill_file?: string;
    leave_out?: string[];
    source?: string;
  } = {},
) => ({
  source_name: options.source ?? "chosen",
  single_file: options.single ?? false,
  files: Object.entries(files).map(([path, content]) => ({
    path: options.single ? path : `${options.source ?? "chosen"}/${path}`,
    content_base64: Buffer.from(content).toString("base64"),
  })),
  ...(options.skill_file ? { skill_file: options.skill_file } : {}),
  ...(options.leave_out ? { leave_out: options.leave_out } : {}),
});

describe("normalizing a chosen skill", () => {
  it("strips the chosen folder, leaves out .DS_Store and .git, and keeps hidden files", () => {
    const result = normalizeUpload(
      upload({
        "SKILL.md": manifest("a"),
        ".DS_Store": "x",
        "sub/.DS_Store": "x",
        ".git/config": "x",
        ".git/objects/1": "x",
        ".github/notes.md": "keep",
      }),
    );
    expect(result.files.map((file) => file.path)).toEqual([
      ".github/notes.md",
      "SKILL.md",
    ]);
    expect(result.excluded).toEqual([
      ".DS_Store",
      "sub/.DS_Store",
      ".git/ (2 files)",
    ]);
    expect(result.errors).toEqual([]);
  });

  it("accepts any file name, choosing the only skill-like file and saying so", () => {
    const result = normalizeUpload(
      upload({
        "architect.md": manifest("arch"),
        "notes/a.md": "see architect.md",
      }),
    );
    expect(result.skill_file).toBe("architect.md");
    expect(result.auto_chosen).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "notes/a.md",
    ]);
    expect(result.broken_links).toEqual(["notes/a.md"]);
  });

  it("waits for the lead's choice when several files look like skill files", () => {
    const files = { "a.md": manifest("a"), "b.md": manifest("b") };
    expect(normalizeUpload(upload(files)).skill_file).toBeNull();
    const chosen = normalizeUpload(upload(files, { skill_file: "b.md" }));
    expect(chosen.skill_file).toBe("b.md");
    expect(chosen.files.map((file) => file.path)).toEqual(["SKILL.md", "a.md"]);
  });

  it("reports a file that would collide with SKILL.md until it is left out", () => {
    const files = { "arch.md": manifest("arch"), "skill.md": "notes" };
    expect(normalizeUpload(upload(files)).destination_clash).toBe("skill.md");
    expect(
      normalizeUpload(upload(files, { leave_out: ["skill.md"] }))
        .destination_clash,
    ).toBeNull();
  });

  it("rejects unsafe, duplicate and case-duplicate paths, and the limits", () => {
    expect(
      normalizeUpload(upload({ "SKILL.md": manifest("a"), "../x": "x" }))
        .errors,
    ).toEqual([expect.stringContaining("Unsafe file path")]);
    expect(
      normalizeUpload(
        upload({ "SKILL.md": manifest("a"), "A.md": "1", "a.md": "2" }),
      ).errors,
    ).toEqual([expect.stringContaining("differ only in letter case")]);
    expect(
      normalizeUpload(
        upload({
          "SKILL.md": manifest("a"),
          "big.bin": "x".repeat(600 * 1024),
        }),
      ).errors,
    ).toEqual(["big.bin is larger than 512 KB."]);
  });

  it("rejects absolute paths as sent, before taking off the folder name", () => {
    const result = normalizeUpload({
      source_name: "x",
      single_file: false,
      files: [
        {
          path: "/etc/x/SKILL.md",
          content_base64: Buffer.from(manifest("a")).toString("base64"),
        },
        { path: "x//y.md", content_base64: "" },
      ],
    });
    expect(result.errors).toEqual([
      'Unsafe file path: "/etc/x/SKILL.md".',
      'Unsafe file path: "x//y.md".',
      "No files were chosen.",
    ]);
  });

  it("uses the lead's explicit choice over a top-level SKILL.md, and the clash it leaves", () => {
    const files = {
      "SKILL.md": manifest("upper"),
      "skill.md": manifest("lower"),
    };
    const first = normalizeUpload(upload(files));
    expect(first).toMatchObject({
      skill_file: "SKILL.md",
      destination_clash: "skill.md",
    });
    const chosen = normalizeUpload(upload(files, { skill_file: "skill.md" }));
    // While the clash is unresolved, SKILL.md is the chosen file, never the other one.
    expect(
      chosen.files.map((file) => [file.path, file.content.toString()]),
    ).toEqual([["SKILL.md", manifest("lower")]]);
    expect(chosen).toMatchObject({
      skill_file: "skill.md",
      destination_clash: "SKILL.md",
    });
    const resolved = normalizeUpload(
      upload(files, { skill_file: "skill.md", leave_out: ["SKILL.md"] }),
    );
    expect(resolved.destination_clash).toBeNull();
    expect(resolved.excluded).toEqual(["SKILL.md"]);
    expect(
      resolved.files.map((file) => [file.path, file.content.toString()]),
    ).toEqual([["SKILL.md", manifest("lower")]]);
  });

  it("imports a single file of any name as SKILL.md and warns about files it links to", () => {
    const result = normalizeUpload(
      upload(
        {
          "pm.txt": `${manifest("pm")}See [the list](checklists/accept.md) and \`scripts/run.sh\` and [web](https://x.y).\n`,
        },
        { single: true },
      ),
    );
    expect(result.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(result.missing_references.sort()).toEqual([
      "checklists/accept.md",
      "scripts/run.sh",
    ]);
  });
});

describe("importing a local skill", () => {
  let home: string;
  let root: string;
  let db: Db;
  let library: SkillLibrary;
  let libraryId: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "konfab-local-import-"));
    root = join(home, "skills");
    mkdirSync(root);
    db = openDatabase(join(home, "konfab.db"));
    library = new SkillLibrary(db);
    libraryId = library.registerLibrary("personal", root);
  });
  afterEach(() => {
    workspaceHooks.afterStep = undefined;
    workspaceHooks.beforeFile = undefined;
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const preview = (u: ReturnType<typeof upload>, name?: string) =>
    library.prepareLocalImport(libraryId, u, name);
  const commit = (
    u: ReturnType<typeof upload>,
    name: string,
    action: "create" | "replace" = "create",
  ) =>
    library.importLocal(libraryId, u, name, action, preview(u, name).expected);

  it("creates the folder named after the skill, with SKILL.md, unreviewed, licence and provenance kept", () => {
    const u = upload(
      {
        "architect.md": manifest("robotics-architect", "license: MIT\n"),
        "refs/notes.md": "notes",
      },
      { source: "guide-robotics-architect" },
    );
    const shown = preview(u);
    expect(shown).toMatchObject({
      name: "robotics-architect",
      skill_file: "architect.md",
      licence: "MIT",
      collision: null,
      errors: [],
    });
    const result = commit(u, "robotics-architect");
    expect(result).toMatchObject({ folder: "ready", number: 1 });
    const folder = join(root, "robotics-architect");
    expect(readdirSync(folder).sort()).toEqual(["SKILL.md", "refs"]);
    expect(readFileSync(join(folder, "refs", "notes.md"), "utf8")).toBe(
      "notes",
    );
    const detail = library.detail(result.skill_id);
    expect(detail.licence).toBe("MIT");
    expect(detail.reviewed_at).toBeNull();
    expect(JSON.parse(detail.provenance_json)).toMatchObject({
      local_import: {
        source_name: "guide-robotics-architect",
        skill_file: "architect.md",
      },
    });
  });

  it("renames the imported copy, keeping comments and other keys", () => {
    const u = upload({
      "SKILL.md":
        "---\n# my note\nname: old\ndescription: Designs things\nlicense: MIT\n---\nBody\n",
    });
    const shown = preview(u, "new-name");
    expect(shown.rename).toEqual({ from: "old", to: "new-name" });
    expect(shown.manifest_text).toContain("# my note");
    expect(shown.manifest_text).toContain("name: new-name");
    commit(u, "new-name");
    expect(readFileSync(join(root, "new-name", "SKILL.md"), "utf8")).toBe(
      "---\n# my note\nname: new-name\ndescription: Designs things\nlicense: MIT\n---\nBody\n",
    );
  });

  it("reports each kind of collision and allows a built-in name", () => {
    commit(upload({ "SKILL.md": manifest("taken") }), "taken");
    expect(
      preview(upload({ "SKILL.md": manifest("taken") })).collision,
    ).toMatchObject({
      kind: "tracked",
      number: 1,
      draft: false,
    });
    mkdirSync(join(root, "loose"));
    expect(
      preview(upload({ "SKILL.md": manifest("loose") })).collision,
    ).toEqual({
      kind: "untracked",
    });
    const gone = commit(upload({ "SKILL.md": manifest("gone") }), "gone");
    const hash = library.detail(gone.skill_id);
    library.trash(gone.skill_id, gone.revision_id, hash.content_hash);
    expect(preview(upload({ "SKILL.md": manifest("gone") })).collision).toEqual(
      {
        kind: "trashed",
      },
    );
    expect(() =>
      commit(upload({ "SKILL.md": manifest("loose") }), "loose"),
    ).toThrow("already exists");
  });

  it("replaces a saved skill with a new unreviewed revision, keeping the old folder until removed", () => {
    const first = commit(upload({ "SKILL.md": manifest("pm") }), "pm");
    library.markReviewed(first.skill_id, first.revision_id);
    const second = upload({ "SKILL.md": manifest("pm", "license: MIT\n") });
    const shown = preview(second);
    expect(shown.collision).toMatchObject({ kind: "tracked", number: 1 });
    const result = commit(second, "pm", "replace");
    expect(result).toMatchObject({ folder: "ready", number: 2 });
    expect(readFileSync(join(root, "pm", "SKILL.md"), "utf8")).toContain(
      "license: MIT",
    );
    expect(library.revisions(first.skill_id)).toHaveLength(2);
    expect(library.detail(first.skill_id).reviewed_at).toBeNull();
    const kept = library.keptFolders(libraryId);
    expect(kept).toEqual([
      expect.objectContaining({
        skill: "pm",
        kind: "previous",
        revision: 1,
        edited: false,
      }),
    ]);
    expect(readFileSync(join(kept[0]!.path, "SKILL.md"), "utf8")).toBe(
      manifest("pm"),
    );
    library.removeKept(kept[0]!.id);
    expect(library.keptFolders(libraryId)).toEqual([]);
    expect(readdirSync(join(root, KEPT_ROOT))).toEqual([]);
  });

  it("refuses to replace a folder with unsaved edits, and a stale preview", () => {
    const first = commit(upload({ "SKILL.md": manifest("pm") }), "pm");
    const u = upload({ "SKILL.md": manifest("pm", "license: MIT\n") });
    const stale = preview(u).expected;
    writeFileSync(join(root, "pm", "extra.md"), "edit");
    expect(() =>
      library.importLocal(libraryId, u, "pm", "replace", stale),
    ).toThrow("changed since you previewed");
    expect(() => commit(u, "pm", "replace")).toThrow("unsaved edits");
    expect(library.revisions(first.skill_id)).toHaveLength(1);
  });

  it("never replaces anything that appears at the folder path, and moves it aside only when asked", () => {
    const u = upload({ "SKILL.md": manifest("fresh") });
    const expected = preview(u).expected;
    workspaceHooks.afterStep = (step) => {
      if (step === "claim") return;
      if (step === "write") {
        // Someone replaces the claim with their own non-empty folder.
        rmSync(join(root, "fresh"), { recursive: true });
        mkdirSync(join(root, "fresh"));
        writeFileSync(join(root, "fresh", "theirs.txt"), "theirs");
      }
    };
    const result = library.importLocal(
      libraryId,
      u,
      "fresh",
      "create",
      expected,
    );
    workspaceHooks.afterStep = undefined;
    expect(result).toMatchObject({
      folder: "pending",
      pending_reason: { code: "folder_exists" },
    });
    expect(readdirSync(join(root, "fresh"))).toEqual(["theirs.txt"]);
    // Moving the other folder aside keeps it, and the import is then written.
    expect(
      library.resolveWorkspace(result.skill_id, "move_aside", "folder_exists"),
    ).toEqual({ folder: "ready" });
    expect(readFileSync(join(root, "fresh", "SKILL.md"), "utf8")).toBe(
      manifest("fresh"),
    );
    const kept = library.keptFolders(libraryId);
    expect(kept).toEqual([expect.objectContaining({ kind: "other" })]);
    expect(readFileSync(join(kept[0]!.path, "theirs.txt"), "utf8")).toBe(
      "theirs",
    );
  });

  it("stops without overwriting when a file appears while writing, and never follows a link", () => {
    const u = upload({ "SKILL.md": manifest("busy"), "sub/a.md": "a" });
    workspaceHooks.beforeFile = (path) => {
      if (path === "sub/a.md")
        symlinkSync(join(home, "elsewhere"), join(root, "busy", "sub"));
    };
    const result = commit(u, "busy");
    workspaceHooks.beforeFile = undefined;
    expect(result).toMatchObject({
      folder: "pending",
      pending_reason: { code: "folder_edited" },
    });
    expect(lstatSync(join(root, "busy", "sub")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, "elsewhere"))).toBe(false);
  });

  it("resumes after a crash at each step, across a restart", () => {
    const path = join(home, "konfab.db");
    for (const crashAfter of ["claim", "write", "verify"] as const) {
      const name = `crash-${crashAfter}`;
      const u = upload({ "SKILL.md": manifest(name), "x/y.md": "y" });
      const expected = preview(u).expected;
      workspaceHooks.afterStep = (step) => {
        if (step === crashAfter) throw new Error("crash");
      };
      const result = library.importLocal(
        libraryId,
        u,
        name,
        "create",
        expected,
      );
      workspaceHooks.afterStep = undefined;
      expect(result.folder).toBe("pending");
      db.close();
      db = openDatabase(path);
      library = new SkillLibrary(db);
      expect(readFileSync(join(root, name, "x", "y.md"), "utf8")).toBe("y");
      expect(existsSync(join(root, name, ".konfab-writing"))).toBe(false);
      expect(library.workspaceReason(result.skill_id)).toBeNull();
    }
  });

  it("keeps the previous folder through a crash during replace", () => {
    const path = join(home, "konfab.db");
    const first = commit(upload({ "SKILL.md": manifest("pm") }), "pm");
    const u = upload({ "SKILL.md": manifest("pm", "license: MIT\n") });
    const expected = preview(u).expected;
    workspaceHooks.afterStep = (step) => {
      if (step === "claim") throw new Error("crash");
    };
    library.importLocal(libraryId, u, "pm", "replace", expected);
    workspaceHooks.afterStep = undefined;
    // The old folder is safe in its kept copy while the new one isn't written.
    const kept = library.keptFolders(libraryId);
    expect(readFileSync(join(kept[0]!.path, "SKILL.md"), "utf8")).toBe(
      manifest("pm"),
    );
    db.close();
    db = openDatabase(path);
    library = new SkillLibrary(db);
    expect(readFileSync(join(root, "pm", "SKILL.md"), "utf8")).toContain("MIT");
    expect(library.workspaceReason(first.skill_id)).toBeNull();
  });

  it("saves edits made after the check as a new revision on top, or keeps them aside, as the lead chooses", () => {
    for (const action of ["save_edits", "move_aside"] as const) {
      const name = `pm-${action.replace("_", "-")}`;
      const first = commit(upload({ "SKILL.md": manifest(name) }), name);
      const u = upload({ "SKILL.md": manifest(name, "license: MIT\n") });
      const expected = preview(u).expected;
      // An edit lands between Konfab's check and moving the folder aside.
      workspaceHooks.afterStep = (step) => {
        if (step === "aside")
          writeFileSync(join(root, name, "late.md"), "late edit");
      };
      const result = library.importLocal(
        libraryId,
        u,
        name,
        "replace",
        expected,
      );
      workspaceHooks.afterStep = undefined;
      expect(result).toMatchObject({
        folder: "pending",
        pending_reason: { code: "folder_edited" },
      });
      expect(readFileSync(join(root, name, "late.md"), "utf8")).toBe(
        "late edit",
      );
      expect(
        library.resolveWorkspace(first.skill_id, action, "folder_edited"),
      ).toEqual({ folder: "ready" });
      if (action === "save_edits") {
        // The edited folder became rev 3; the import is rev 2 in History.
        expect(library.revisions(first.skill_id)).toHaveLength(3);
        expect(readFileSync(join(root, name, "late.md"), "utf8")).toBe(
          "late edit",
        );
      } else {
        expect(readFileSync(join(root, name, "SKILL.md"), "utf8")).toContain(
          "MIT",
        );
        const kept = library
          .keptFolders(libraryId)
          .find((item) => item.skill === name);
        expect(kept?.kind).toBe("edits");
        expect(readFileSync(join(kept!.path, "late.md"), "utf8")).toBe(
          "late edit",
        );
      }
      expect(() =>
        library.resolveWorkspace(first.skill_id, "retry", "folder_edited"),
      ).toThrow("This changed");
    }
  });

  it("imports the file the lead chose over a clashing SKILL.md, end to end", () => {
    const u = upload(
      { "SKILL.md": manifest("upper"), "skill.md": manifest("lower") },
      { skill_file: "skill.md", leave_out: ["SKILL.md"] },
    );
    expect(preview(u)).toMatchObject({
      name: "lower",
      destination_clash: null,
      errors: [],
    });
    expect(commit(u, "lower").folder).toBe("ready");
    expect(readdirSync(join(root, "lower"))).toEqual(["SKILL.md"]);
    expect(readFileSync(join(root, "lower", "SKILL.md"), "utf8")).toBe(
      manifest("lower"),
    );
  });

  describe("a crash right after each file system change, before the journal catches up", () => {
    const labels = [
      "kept-root",
      "holder",
      "aside",
      "marker",
      "mkdir",
      "file",
      "unmark",
    ];
    for (const label of labels)
      for (const action of ["create", "replace"] as const) {
        if (
          action === "create" &&
          ["kept-root", "holder", "aside"].includes(label)
        )
          continue;
        it(`${action}: after ${label}`, () => {
          const path = join(home, "konfab.db");
          const name = `b-${label}-${action}`;
          if (action === "replace")
            commit(upload({ "SKILL.md": manifest(name) }), name);
          const u = upload({
            "SKILL.md": manifest(name, "license: MIT\n"),
            "x/y.md": "y".repeat(100),
          });
          const expected = preview(u).expected;
          let fired = false;
          workspaceHooks.afterFs = (at) => {
            if (at !== label || fired) return;
            if (at === "file" && existsSync(join(root, name, "x", "y.md")))
              // A partial write of the file being written.
              writeFileSync(join(root, name, "x", "y.md"), "y".repeat(40));
            else if (at === "file") return;
            fired = true;
            throw new Error("crash");
          };
          const result = library.importLocal(
            libraryId,
            u,
            name,
            action,
            expected,
          );
          workspaceHooks.afterFs = undefined;
          expect(fired).toBe(true);
          expect(result.folder).toBe("pending");
          db.close();
          db = openDatabase(path);
          library = new SkillLibrary(db);
          expect(library.workspaceReason(result.skill_id)).toBeNull();
          expect(readFileSync(join(root, name, "SKILL.md"), "utf8")).toContain(
            "MIT",
          );
          expect(readFileSync(join(root, name, "x", "y.md"), "utf8")).toBe(
            "y".repeat(100),
          );
          expect(existsSync(join(root, name, ".konfab-writing"))).toBe(false);
          if (action === "replace") {
            const kept = library
              .keptFolders(libraryId)
              .filter((item) => item.skill === name);
            expect(kept).toHaveLength(1);
            expect(readFileSync(join(kept[0]!.path, "SKILL.md"), "utf8")).toBe(
              manifest(name),
            );
          }
        });
      }

    it("create: after making the folder but before recording it, the empty folder isn't used without the lead", () => {
      const path = join(home, "konfab.db");
      const u = upload({ "SKILL.md": manifest("unrecorded") });
      const expected = preview(u).expected;
      workspaceHooks.afterFs = (at) => {
        if (at === "claim") throw new Error("crash");
      };
      const result = library.importLocal(
        libraryId,
        u,
        "unrecorded",
        "create",
        expected,
      );
      workspaceHooks.afterFs = undefined;
      db.close();
      db = openDatabase(path);
      library = new SkillLibrary(db);
      expect(library.workspaceReason(result.skill_id)).toMatchObject({
        code: "folder_exists",
        detail: expect.stringContaining(
          "may have created it just before it stopped",
        ),
      });
      expect(readdirSync(join(root, "unrecorded"))).toEqual([]);
      expect(
        library.resolveWorkspace(
          result.skill_id,
          "move_aside",
          "folder_exists",
        ),
      ).toEqual({ folder: "ready" });
      expect(readFileSync(join(root, "unrecorded", "SKILL.md"), "utf8")).toBe(
        manifest("unrecorded"),
      );
    });
  });
});
