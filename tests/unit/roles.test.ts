import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/index.js";
import { RoleLibrary } from "../../src/server/domain/roles.js";
import { KonfabService } from "../../src/server/domain/service.js";
import { SkillLibrary } from "../../src/server/domain/skills.js";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("role assignment", () => {
  it("seeds built-ins idempotently and limits reads to the assigned revision", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-role-seed-"));
    const db = openDatabase(":memory:");
    try {
      const roles = new RoleLibrary(db);
      roles.seedBuiltins("src/server/roles/builtin");
      roles.seedBuiltins("src/server/roles/builtin");
      expect(roles.list()).toHaveLength(4);
      db.prepare(
        "INSERT INTO role_libraries(id, kind, root_path) VALUES ('personal', 'personal', ?)",
      ).run(join(root, "roles"));
      const builtin = roles.list()[0] as { id: string };
      const copy = roles.duplicate(builtin.id, "my-role");
      expect(roles.detail(copy)).toEqual(
        expect.objectContaining({
          name: "my-role",
          library_id: "personal",
          title: expect.stringMatching(/ \(copy\)$/),
        }),
      );
      const service = new KonfabService(db, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      service.ensureAgent("worker", "Worker");
      const room = service.createRoom("roles", "", ["worker"]);
      const member = service.join("worker", "roles");
      const role = roles.list()[0] as { id: string; revision_id: string };
      roles.assign(room.id, "worker", role.id, role.revision_id, "Room note");
      const full = roles.envelope(room.id, "worker", true);
      expect(full).toEqual(
        expect.objectContaining({ changed: true, notes: "Room note" }),
      );
      expect(roles.envelope(room.id, "worker", true)).toEqual(
        expect.objectContaining({ changed: false }),
      );
      expect(() =>
        roles.assign(
          room.id,
          "worker",
          role.id,
          role.revision_id,
          "New note",
          9,
        ),
      ).toThrow("assignment changed");
      expect(service.readAssignedRole("worker", member.session_id)).toEqual(
        expect.objectContaining({
          notes: "Room note",
          role_md: expect.any(String),
        }),
      );
      const rejoined = service.join("worker", "roles");
      expect(rejoined.role).toEqual(
        expect.objectContaining({ role_md: expect.any(String) }),
      );
      roles.assign(
        room.id,
        "worker",
        role.id,
        role.revision_id,
        "Updated note",
        1,
      );
      service.postUserMessage("roles", "@worker go");
      const turn = service.poll("worker", rejoined.session_id, true);
      const replay = service.poll("worker", rejoined.session_id, true);
      expect(turn.status).toBe("turn");
      if (turn.status === "turn" && replay.status === "turn") {
        expect(turn.role).toEqual(
          expect.objectContaining({ changed: true, notes: "Updated note" }),
        );
        expect(replay.role).toEqual(turn.role);
      }
      service.setMemberRole(room.id, "worker", {
        role: "Custom",
        can_edit: false,
        base_role_revision: 2,
      });
      expect(() =>
        roles.assign(room.id, "worker", role.id, role.revision_id, "stale", 2),
      ).toThrow("assignment changed");
      roles.assign(room.id, "worker", role.id, role.revision_id, "Current", 3);
      expect(
        service.readAssignedRoleFile(
          "worker",
          rejoined.session_id,
          role.revision_id,
          "ROLE.md",
          0,
          8,
        ),
      ).toEqual(expect.objectContaining({ content: expect.any(String) }));
      expect(() =>
        service.readAssignedRoleFile(
          "worker",
          rejoined.session_id,
          "00000000-0000-4000-8000-000000000000",
          "ROLE.md",
          0,
          8,
        ),
      ).toThrow("not assigned");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("retains a skill-created role and pinned assignment after reopening the database", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-picker-reopen-"));
    const database = join(root, "state.db");
    let db = openDatabase(database);
    try {
      const roles = new RoleLibrary(db);
      db.prepare(
        "INSERT INTO role_libraries(id,kind,root_path) VALUES ('personal','personal', ?)",
      ).run(join(root, "roles"));
      const skillRoot = join(root, "skills");
      mkdirSync(skillRoot);
      const skills = new SkillLibrary(db);
      const libraryId = skills.registerLibrary("personal", skillRoot);
      const skillId = skills.create(
        libraryId,
        "sample-skill",
        "A sample skill",
      );
      const detail = skills.detail(skillId);
      const revision = String(detail.current_revision_id);
      skills.markReviewed(skillId, revision);
      const service = new KonfabService(db, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      service.ensureAgent("worker", "Worker");
      const room = service.createRoom("picker", "", ["worker"]);
      const created = roles.createAndAssignSkill({
        roomId: room.id,
        agentId: "worker",
        libraryId,
        skillId,
        skillRevision: revision,
        name: "sample-role",
        title: "Sample role",
        description: "A sample role",
        instructions: "Use the skill.",
        notes: "",
      });
      expect(created.pending).toBe(false);
      db.close();
      db = openDatabase(database);
      const reopened = new RoleLibrary(db);
      expect(reopened.envelope(room.id, "worker", false, true)).toEqual(
        expect.objectContaining({
          id: created.id,
          skills: expect.arrayContaining([
            expect.objectContaining({ skill_revision_id: revision }),
          ]),
        }),
      );
      expect(existsSync(join(root, "roles", "sample-role", "ROLE.md"))).toBe(
        true,
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("recovers a pending skill workspace after a database reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-skill-journal-"));
    const database = join(root, "state.db");
    let db = openDatabase(database);
    try {
      const skillsRoot = join(root, "skills");
      mkdirSync(skillsRoot);
      const skills = new SkillLibrary(db);
      const libraryId = skills.registerLibrary("personal", skillsRoot);
      const files = [
        {
          path: "SKILL.md",
          mode: 0o600,
          content: Buffer.from(
            "---\nname: copied\ndescription: Copy\n---\nBody",
          ),
        },
      ];
      const created = skills.createReviewedForAssignment(
        libraryId,
        files,
        {},
        null,
        (id) => id,
      );
      expect(created.pending).toBe(false);
      rmSync(join(skillsRoot, "copied"), { recursive: true });
      db.prepare(
        "UPDATE skill_workspace_operations SET state='pending' WHERE skill_id=?",
      ).run(created.value);
      db.close();
      db = openDatabase(database);
      new SkillLibrary(db);
      expect(
        readFileSync(join(skillsRoot, "copied", "SKILL.md"), "utf8"),
      ).toContain("Body");
      expect(
        (
          db
            .prepare(
              "SELECT state FROM skill_workspace_operations WHERE skill_id=?",
            )
            .get(created.value) as { state: string }
        ).state,
      ).toBe("complete");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(["empty staging directory", "partially written staging file"])(
    "recovers %s after reopening",
    (crash) => {
      const root = mkdtempSync(join(tmpdir(), "konfab-skill-crash-"));
      const database = join(root, "state.db");
      let db = openDatabase(database);
      try {
        const skillsRoot = join(root, "skills");
        mkdirSync(skillsRoot);
        const skills = new SkillLibrary(db);
        const libraryId = skills.registerLibrary("personal", skillsRoot);
        const files = [
          {
            path: "SKILL.md",
            mode: 0o600,
            content: Buffer.from(
              "---\nname: copied\ndescription: Copy\n---\nBody",
            ),
          },
        ];
        const created = skills.createReviewedForAssignment(
          libraryId,
          files,
          {},
          null,
          (id) => id,
        );
        rmSync(join(skillsRoot, "copied"), { recursive: true });
        const staging = join(skillsRoot, `.konfab-pending-${created.value}`);
        mkdirSync(staging);
        if (crash === "partially written staging file") {
          writeFileSync(
            join(staging, ".konfab-workspace-owner"),
            created.value,
          );
          writeFileSync(join(staging, "SKILL.md"), "partial");
        }
        db.prepare(
          "UPDATE skill_workspace_operations SET state='pending' WHERE skill_id=?",
        ).run(created.value);
        db.close();
        db = openDatabase(database);
        new SkillLibrary(db);
        expect(
          readFileSync(join(skillsRoot, "copied", "SKILL.md"), "utf8"),
        ).toContain("Body");
        expect(
          (
            db
              .prepare(
                "SELECT state FROM skill_workspace_operations WHERE skill_id=?",
              )
              .get(created.value) as { state: string }
          ).state,
        ).toBe("complete");
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps externally changed pending skill files intact during recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-skill-conflict-"));
    const database = join(root, "state.db");
    let db = openDatabase(database);
    try {
      const skillsRoot = join(root, "skills");
      mkdirSync(skillsRoot);
      const skills = new SkillLibrary(db);
      const libraryId = skills.registerLibrary("personal", skillsRoot);
      const files = [
        {
          path: "SKILL.md",
          mode: 0o600,
          content: Buffer.from(
            "---\nname: copied\ndescription: Copy\n---\nBody",
          ),
        },
      ];
      const created = skills.createReviewedForAssignment(
        libraryId,
        files,
        {},
        null,
        (id) => id,
      );
      const folder = join(skillsRoot, "copied");
      writeFileSync(join(folder, "SKILL.md"), "external change");
      writeFileSync(join(folder, ".konfab-workspace-owner"), created.value);
      db.prepare(
        "UPDATE skill_workspace_operations SET state='pending' WHERE skill_id=?",
      ).run(created.value);
      db.close();
      db = openDatabase(database);
      new SkillLibrary(db);
      expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(
        "external change",
      );
      expect(
        (
          db
            .prepare(
              "SELECT state FROM skill_workspace_operations WHERE skill_id=?",
            )
            .get(created.value) as { state: string }
        ).state,
      ).toBe("pending");
      expect(new SkillLibrary(db).list(libraryId).skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workspace_state: "pending" }),
        ]),
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reconstructs a missing journaled role file after a database reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-role-recovery-"));
    const database = join(root, "state.db");
    let db = openDatabase(database);
    try {
      const roles = new RoleLibrary(db);
      db.prepare(
        "INSERT INTO role_libraries(id,kind,root_path) VALUES ('personal','personal', ?)",
      ).run(join(root, "roles"));
      const id = roles.createPersonal(
        "personal",
        "test-role",
        [
          {
            path: "ROLE.md",
            content: Buffer.from(
              "---\nname: test-role\ntitle: Test\ndescription: Recovery\n---\nBody",
            ),
            mode: 0o600,
          },
        ],
        [],
      );
      const path = join(root, "roles", "test-role", "ROLE.md");
      unlinkSync(path);
      db.prepare(
        "UPDATE role_workspace_operations SET state = 'pending' WHERE role_id = ?",
      ).run(id);
      db.close();
      db = openDatabase(database);
      new RoleLibrary(db);
      expect(readFileSync(path, "utf8")).toContain("Recovery");
      expect(
        db
          .prepare(
            "SELECT state FROM role_workspace_operations WHERE role_id = ?",
          )
          .get(id),
      ).toEqual({ state: "complete" });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("blocks unreviewed skill pins until that exact revision is reviewed", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-role-test-"));
    const db = openDatabase(":memory:");
    try {
      const skills = new SkillLibrary(db);
      const library = skills.registerLibrary("personal", root);
      const skill = skills.create(library, "example", "Example skill");
      const revision = skills.detail(skill).current_revision_id;
      const roles = new RoleLibrary(db);
      db.prepare(
        "INSERT INTO role_libraries(id,kind,root_path) VALUES ('personal','personal', ?)",
      ).run(join(root, "roles"));
      const role = roles.createPersonal(
        "personal",
        "test-role",
        [
          {
            path: "ROLE.md",
            content: Buffer.from(
              "---\nname: test-role\ntitle: Test\ndescription: Test role\n---\nBody",
            ),
            mode: 0o600,
          },
        ],
        [{ skill_id: skill, revision_id: revision }],
      );
      expect(() =>
        roles.createPersonal(
          "personal",
          "test-role",
          [
            {
              path: "ROLE.md",
              content: Buffer.from(
                "---\nname: test-role\ntitle: Test\ndescription: Duplicate\n---\n",
              ),
              mode: 0o600,
            },
          ],
          [],
        ),
      ).toThrow("already exists");
      const roleRevision = (
        roles.detail(role) as unknown as { revision_id: string }
      ).revision_id;
      expect(existsSync(join(root, "roles", "test-role", "ROLE.md"))).toBe(
        true,
      );
      const service = new KonfabService(db, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      service.ensureAgent("worker", "Worker");
      const room = service.createRoom("review", "", ["worker"]);
      expect(() =>
        roles.assign(room.id, "worker", role, roleRevision, ""),
      ).toThrow("Review before assignment");
      skills.markReviewed(skill, revision);
      roles.assign(room.id, "worker", role, roleRevision, "");
      expect(() => roles.trash(role, roleRevision)).toThrow("Role in use");
      const joined = service.join("worker", "review");
      expect(
        service.readAssignedSkillFile(
          "worker",
          joined.session_id,
          revision,
          "SKILL.md",
          0,
          20,
        ),
      ).toEqual(expect.objectContaining({ content: expect.any(String) }));
      expect(() =>
        service.readAssignedSkillFile(
          "worker",
          joined.session_id,
          "00000000-0000-4000-8000-000000000000",
          "SKILL.md",
          0,
          20,
        ),
      ).toThrow("not assigned");
      expect(roles.envelope(room.id, "worker", false, true)).toEqual(
        expect.objectContaining({ name: "test-role" }),
      );
      const newRevision = roles.saveManifest(
        role,
        roleRevision,
        "---\nname: test-role\ntitle: Updated\ndescription: Test role\n---\nBody",
        [{ skill_id: skill, revision_id: revision }],
      );
      expect(newRevision).not.toBe(roleRevision);
      expect(
        readFileSync(join(root, "roles", "test-role", "ROLE.md"), "utf8"),
      ).toContain("Updated");
      const restored = roles.restoreRevision(role, roleRevision, newRevision);
      expect(restored).not.toBe(roleRevision);
      expect(
        readFileSync(join(root, "roles", "test-role", "ROLE.md"), "utf8"),
      ).not.toContain("Updated");
      expect(roles.envelope(room.id, "worker", false, true)).toEqual(
        expect.objectContaining({ revision_id: roleRevision }),
      );
      expect(() => roles.saveManifest(role, roleRevision, "stale", [])).toThrow(
        "changed elsewhere",
      );
      writeFileSync(
        join(root, "roles", "test-role", "ROLE.md"),
        "outside edit",
      );
      expect(() => roles.saveManifest(role, restored, "new text", [])).toThrow(
        "workspace changed",
      );
      writeFileSync(
        join(root, "roles", "test-role", "ROLE.md"),
        "---\nname: test-role\ntitle: Outside\ndescription: Test role\n---\nBody",
      );
      const draft = roles.workingDraft(role);
      expect(() =>
        roles.saveWorkingDraft(role, restored, "0".repeat(64), []),
      ).toThrow("workspace changed");
      const outsideRevision = roles.saveWorkingDraft(
        role,
        restored,
        draft.draft_hash,
        [],
      );
      expect(roles.detail(role)).toEqual(
        expect.objectContaining({
          revision_id: outsideRevision,
          title: "Outside",
        }),
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
