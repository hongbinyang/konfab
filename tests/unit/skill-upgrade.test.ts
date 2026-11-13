import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupBeforeUpgrade,
  ConcurrentUseError,
  migrate,
  openDatabase,
  SKILL_UPGRADE_VERSION,
  type Db,
} from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";
import { SkillLibrary } from "../../src/server/domain/skills.js";
import { packageHash } from "../../src/server/domain/skill-files.js";
import { checkUpgrade } from "../../src/server/db/upgrade-check.js";
import { buildOldDatabase, OLD_VERSION } from "../fixtures/old-database.js";

const NOW = 1_700_000_000_000;

const options = {
  waitTimeoutSeconds: 1,
  turnTimeoutMs: 60 * 60_000,
  maxMessageChars: 10_000,
  now: () => Date.now(),
};

describe("upgrading roles to skills", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "konfab-upgrade-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const pins = (db: Db, agent: string) =>
    db
      .prepare(
        `SELECT s.folder_name, r.number, p.delivery FROM room_member_skills p
         JOIN skills s ON s.id = p.skill_id JOIN skill_revisions r ON r.id = p.skill_revision_id
         WHERE p.agent_id = ? ORDER BY p.position`,
      )
      .all(agent);

  it("converts every role in use into reviewed skills without overwriting anything", () => {
    const fixture = buildOldDatabase(dir);
    const db = openDatabase(fixture.path);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(
        SKILL_UPGRADE_VERSION,
      );
      // The colliding names get suffixes; the unrelated skill and the stray folder stay.
      expect(pins(db, "claude")).toEqual([
        { folder_name: "konfab-dev-role", number: 2, delivery: "full" },
        { folder_name: "helper", number: 2, delivery: "summary" },
      ]);
      expect(pins(db, "codex")).toEqual([
        { folder_name: "reviewer-role", number: 1, delivery: "full" },
      ]);
      expect(pins(db, "gemini")).toEqual([]);
      const members = db
        .prepare(
          "SELECT agent_id, instructions, legacy_role_revision_id, upgrade_notice FROM room_members ORDER BY position",
        )
        .all();
      expect(members).toEqual([
        {
          agent_id: "claude",
          instructions: "Room notes",
          legacy_role_revision_id: "dev-2",
          upgrade_notice: 1,
        },
        {
          agent_id: "codex",
          instructions: "",
          legacy_role_revision_id: "rev-1",
          upgrade_notice: 1,
        },
        {
          agent_id: "gemini",
          instructions: "Free text role",
          legacy_role_revision_id: null,
          upgrade_notice: 1,
        },
      ]);
      // Both revisions of the role became revisions of one skill: dev-1 is still used by the active turn.
      const converted = db
        .prepare(
          `SELECT r.number, r.name, f.path FROM skill_revisions r JOIN skills s ON s.id = r.skill_id
           JOIN skill_revision_files f ON f.revision_id = r.id JOIN skill_reviews v ON v.revision_id = r.id
           WHERE s.folder_name = 'konfab-dev-role' ORDER BY r.number, f.path`,
        )
        .all();
      expect(converted).toEqual([
        { number: 1, name: "konfab-dev-role", path: "SKILL.md" },
        { number: 1, name: "konfab-dev-role", path: "checklist.md" },
        { number: 2, name: "konfab-dev-role", path: "SKILL.md" },
        { number: 2, name: "konfab-dev-role", path: "checklist.md" },
      ]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%role%' ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "legacy_role_files" },
        { name: "legacy_role_revisions" },
      ]);
      expect(
        db
          .prepare(
            "SELECT owner_type, count(*) AS n FROM skill_usages GROUP BY owner_type ORDER BY owner_type",
          )
          .all(),
      ).toEqual([
        { owner_type: "assignment", n: 3 },
        { owner_type: "turn", n: 2 },
      ]);
      expect(readdirSync(join(dir, "backups"))).toHaveLength(1);

      // Working folders are written after the database step, and never over an existing folder.
      new SkillLibrary(db);
      const skillMd = readFileSync(
        join(fixture.skillsRoot, "konfab-dev-role", "SKILL.md"),
        "utf8",
      );
      expect(skillMd).toBe(
        '---\nname: "konfab-dev-role"\ndescription: "Konfab developer duties"\n---\nDevelop v2',
      );
      expect(
        readFileSync(join(fixture.skillsRoot, "reviewer", "mine.txt"), "utf8"),
      ).toBe("keep me");
      expect(
        existsSync(join(fixture.skillsRoot, "reviewer-role", "SKILL.md")),
      ).toBe(true);
    } finally {
      db.close();
    }
    // Reopening does not upgrade or back up again.
    const again = openDatabase(fixture.path);
    expect(pins(again, "claude")).toHaveLength(2);
    again.close();
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
  });

  it("lets a turn in progress finish with its original role, then delivers the converted assignment", () => {
    const fixture = buildOldDatabase(dir);
    const before = new Database(fixture.path);
    const started = (
      before
        .prepare("SELECT role_envelope_json FROM turns WHERE id = 1")
        .get() as {
        role_envelope_json: string;
      }
    ).role_envelope_json;
    before.close();
    const db = openDatabase(fixture.path);
    try {
      const service = new KonfabService(db, options);
      const replay = service.poll("claude", "s-claude", true);
      if (replay.status !== "turn")
        throw new Error(`expected a turn: ${replay.status}`);
      // The old reply is replayed exactly, with the new form alongside.
      expect(replay.role).toEqual(JSON.parse(started));
      expect(replay.assignment).toMatchObject({
        instructions: "Room notes",
        skills: [
          expect.objectContaining({
            name: "konfab-dev-role",
            number: 1,
            delivery: "full",
          }),
          expect.objectContaining({
            name: "helper",
            number: 1,
            delivery: "summary",
          }),
        ],
      });
      // Files of the turn's own (older) revision stay readable; the new pins do not, yet.
      const role = service.readAssignedRole("claude", "s-claude");
      expect(role.role).toMatchObject({ revision_id: "dev-1" });
      expect(
        service.readAssignedRoleFile(
          "claude",
          "s-claude",
          "dev-1",
          "ROLE.md",
          0,
          4096,
        ),
      ).toMatchObject({ content: expect.stringContaining("Develop v1") });
      expect(
        service.readAssignedRoleFile(
          "claude",
          "s-claude",
          "dev-1",
          "checklist.md",
          0,
          4096,
        ),
      ).toBeTruthy();
      expect(() =>
        service.readAssignedRoleFile(
          "claude",
          "s-claude",
          "dev-2",
          "ROLE.md",
          0,
          4096,
        ),
      ).toThrow(/replaced/);
      expect(
        service.readAssignedSkillFile(
          "claude",
          "s-claude",
          "helper-1",
          "notes.md",
          0,
          4096,
        ),
      ).toBeTruthy();
      expect(() =>
        service.readAssignedSkillFile(
          "claude",
          "s-claude",
          "helper-2",
          "notes.md",
          0,
          4096,
        ),
      ).toThrow(/not assigned/);
      service.passTurn("claude", "s-claude", replay.turn_id);

      // Next turn: the old role contract for the current revision, plus the one-time notice.
      service.postUserMessage(1, "@claude next");
      const next = service.poll("claude", "s-claude", true);
      if (next.status !== "turn") throw new Error("expected a turn");
      expect(next.role).toMatchObject({
        id: "role-dev",
        revision_id: "dev-2",
        changed: true,
        title: "Konfab developer",
        notes: "Room notes",
        role_md: expect.stringContaining("Develop v2"),
        skills: [expect.objectContaining({ skill_revision_id: "helper-2" })],
        notice: expect.stringContaining("Konfab replaced roles with skills"),
      });
      expect(next.assignment).toMatchObject({
        changed: true,
        notice: expect.stringContaining("Konfab replaced roles with skills"),
      });
      expect(next.rules).toContain("Follow your assignment");
      expect(
        service.readAssignedRoleFile(
          "claude",
          "s-claude",
          "dev-2",
          "ROLE.md",
          0,
          4096,
        ),
      ).toBeTruthy();
      service.passTurn("claude", "s-claude", next.turn_id);

      // The first assignment change ends the old contract; old tools still reach the new assignment.
      const current = service.memberAssignment(1, "claude");
      service.setAssignment(1, "claude", {
        base_revision: current.revision,
        instructions: "New notes",
        pins: current.skills.map((skill) => ({
          skill_id: skill.skill_id,
          revision_id: skill.revision_id,
          delivery: "full",
        })),
      });
      service.postUserMessage(1, "@claude again");
      const changed = service.poll("claude", "s-claude", true);
      if (changed.status !== "turn") throw new Error("expected a turn");
      expect(changed.role).toMatchObject({
        changed: true,
        notice: expect.stringContaining("Roles were replaced by skills"),
      });
      expect(changed.assignment).toMatchObject({
        instructions: "New notes",
        notice: expect.stringContaining("Your skills changed"),
      });
      const viaOldTool = service.readAssignedRole("claude", "s-claude");
      expect(viaOldTool.assignment).toMatchObject({
        instructions: "New notes",
      });
      expect(() =>
        service.readAssignedRoleFile(
          "claude",
          "s-claude",
          "dev-2",
          "ROLE.md",
          0,
          4096,
        ),
      ).toThrow(/replaced/);
      expect(
        service.readAssignedSkillFile(
          "claude",
          "s-claude",
          "helper-2",
          "notes.md",
          0,
          4096,
        ),
      ).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("answers old tool calls exactly as the pre-upgrade server did", () => {
    // Recorded by running the same calls with the code before this change (2a282b6) on this fixture.
    const golden = JSON.parse(
      readFileSync("tests/fixtures/old-role-replies.json", "utf8"),
    ) as Record<string, unknown>;
    const same = (actual: unknown, key: string) =>
      expect(JSON.stringify(actual)).toBe(JSON.stringify(golden[key]));
    const fixture = buildOldDatabase(dir);
    const db = openDatabase(fixture.path);
    try {
      const service = new KonfabService(db, options);
      const turn = service.poll("claude", "s-claude", true);
      if (turn.status !== "turn") throw new Error("expected a turn");
      same(turn.role, "wait_active_role");
      same(service.readAssignedRole("claude", "s-claude"), "read_role_active");
      same(
        service.readAssignedRoleFile(
          "claude",
          "s-claude",
          "dev-1",
          "ROLE.md",
          0,
          4096,
        ),
        "read_role_file_active",
      );
      same(
        service.readAssignedSkillFile(
          "claude",
          "s-claude",
          "helper-1",
          "notes.md",
          0,
          4096,
        ),
        "read_skill_file_active",
      );
      service.passTurn("claude", "s-claude", turn.turn_id);
      same(service.readAssignedRole("claude", "s-claude"), "read_role_current");
      same(
        service.readAssignedRoleFile(
          "claude",
          "s-claude",
          "dev-2",
          "checklist.md",
          0,
          4096,
        ),
        "read_role_file_current",
      );
      same(
        service.readAssignedSkillFile(
          "claude",
          "s-claude",
          "helper-2",
          "notes.md",
          0,
          4096,
        ),
        "read_skill_file_current",
      );
      same(service.readAssignedRole("codex", "s-codex"), "read_role_codex");
    } finally {
      db.close();
    }
  });

  it("sends a converted role as a summary when room instructions no longer leave room for it", () => {
    const fixture = buildOldDatabase(dir, { bigRole: 50 * 1024 });
    const raw = new Database(fixture.path);
    raw
      .prepare(
        "UPDATE room_member_roles SET notes = ? WHERE agent_id = 'claude'",
      )
      .run("n".repeat(4000));
    raw
      .prepare("UPDATE room_members SET role = ? WHERE agent_id = 'claude'")
      .run("t".repeat(15 * 1024));
    raw.close();
    const db = openDatabase(fixture.path);
    try {
      expect(pins(db, "claude")).toEqual([
        { folder_name: "konfab-dev-role", number: 2, delivery: "summary" },
        { folder_name: "helper", number: 2, delivery: "summary" },
      ]);
      expect(
        db
          .prepare("SELECT kind FROM upgrade_log WHERE kind = 'summary_to_fit'")
          .all(),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("stops without changing anything when an assignment cannot fit, and retries from a fresh backup", () => {
    const fixture = buildOldDatabase(dir, { freeText: "z".repeat(70 * 1024) });
    expect(() => openDatabase(fixture.path)).toThrow(
      /could not convert[\s\S]*konfab-improvement[\s\S]*Gemini/,
    );
    const raw = new Database(fixture.path);
    expect(raw.pragma("user_version", { simple: true })).toBe(OLD_VERSION);
    expect(
      raw.prepare("SELECT count(*) AS n FROM room_member_roles").get(),
    ).toEqual({ n: 2 });
    // The old version keeps running and writes after the failed attempt.
    raw
      .prepare(
        "UPDATE room_members SET role = 'short' WHERE agent_id = 'gemini'",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO messages(room_id, sender_type, sender_id, body, created_at) VALUES (1, 'user', 'user', 'written after the failed upgrade', ?)",
      )
      .run(NOW);
    raw.close();
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);

    const db = openDatabase(fixture.path);
    db.close();
    const backups = readdirSync(join(dir, "backups")).sort();
    expect(backups).toHaveLength(2);
    // The newest backup holds the later write; restoring it gives the old schema back.
    const restored = join(dir, "restored.db");
    const fresh = backups.find((name) => {
      const check = new Database(join(dir, "backups", name), {
        readonly: true,
      });
      const found = check
        .prepare(
          "SELECT 1 FROM messages WHERE body = 'written after the failed upgrade'",
        )
        .get();
      check.close();
      return !!found;
    });
    expect(fresh).toBeDefined();
    copyFileSync(join(dir, "backups", fresh!), restored);
    const check = new Database(restored);
    expect(check.pragma("user_version", { simple: true })).toBe(OLD_VERSION);
    expect(
      check
        .prepare("SELECT role FROM room_members WHERE agent_id = 'gemini'")
        .get(),
    ).toEqual({
      role: "short",
    });
    check.close();
  });

  it("keeps a role's own SKILL.md under a new name, for current and in-progress revisions", () => {
    const fixture = buildOldDatabase(dir, { roleSkillFile: true });
    const db = openDatabase(fixture.path);
    try {
      const files = db
        .prepare(
          `SELECT r.number, f.path, b.content FROM skill_revisions r JOIN skills s ON s.id = r.skill_id
           JOIN skill_revision_files f ON f.revision_id = r.id JOIN skill_blobs b ON b.hash = f.blob_hash
           WHERE s.folder_name = 'konfab-dev-role' ORDER BY r.number, f.path`,
        )
        .all() as Array<{ number: number; path: string; content: Buffer }>;
      expect(files.map((file) => [file.number, file.path])).toEqual([
        [1, "SKILL.md"],
        [1, "checklist.md"],
        [1, "role-SKILL.md"],
        [2, "SKILL.md"],
        [2, "checklist.md"],
        [2, "role-SKILL.md"],
      ]);
      expect(
        files
          .filter((file) => file.path === "role-SKILL.md")
          .map((file) => file.content.toString("utf8")),
      ).toEqual([
        "role's own SKILL.md for dev-1",
        "role's own SKILL.md for dev-2",
      ]);
      expect(
        files
          .find((file) => file.number === 1 && file.path === "SKILL.md")!
          .content.toString("utf8"),
      ).toContain("Develop v1");
      expect(
        db
          .prepare("SELECT detail FROM upgrade_log WHERE kind = 'renamed_file'")
          .all(),
      ).toHaveLength(2);
      // The turn in progress reads it both ways: as the old role file and as the converted skill's file.
      const service = new KonfabService(db, options);
      const dev1 = (
        db
          .prepare(
            "SELECT skill_revision_id FROM legacy_role_revisions WHERE role_revision_id = 'dev-1'",
          )
          .get() as { skill_revision_id: string }
      ).skill_revision_id;
      expect(
        service.readAssignedRoleFile(
          "claude",
          "s-claude",
          "dev-1",
          "SKILL.md",
          0,
          4096,
        ),
      ).toMatchObject({ content: "role's own SKILL.md for dev-1" });
      expect(
        service.readAssignedSkillFile(
          "claude",
          "s-claude",
          dev1,
          "role-SKILL.md",
          0,
          4096,
        ),
      ).toMatchObject({ content: "role's own SKILL.md for dev-1" });
    } finally {
      db.close();
    }
  });

  it("stops when a turn in progress cannot fit, even though the current assignment does", () => {
    const fixture = buildOldDatabase(dir, {
      snapshotText: "s".repeat(70 * 1024),
    });
    expect(() => openDatabase(fixture.path)).toThrow(
      /could not convert[\s\S]*Claude \(turn in progress\)/,
    );
    const raw = new Database(fixture.path);
    expect(raw.pragma("user_version", { simple: true })).toBe(OLD_VERSION);
    expect(
      raw.prepare("SELECT count(*) AS n FROM role_revisions").get(),
    ).toEqual({ n: 3 });
    raw.close();
  });

  it("previews the upgrade on a copy without touching the live database", () => {
    const fixture = buildOldDatabase(dir);
    const ok = checkUpgrade(fixture.path);
    expect(ok.ok).toBe(true);
    expect(ok.report).toContain(
      "konfab-improvement · Claude: konfab-dev-role rev 2 (full), helper rev 2 (summary)",
    );
    expect(ok.report).toContain(
      "Role Konfab developer became the personal skill konfab-dev-role",
    );
    const raw = new Database(fixture.path);
    expect(raw.pragma("user_version", { simple: true })).toBe(OLD_VERSION);
    raw
      .prepare("UPDATE room_members SET role = ? WHERE agent_id = 'gemini'")
      .run("z".repeat(70 * 1024));
    raw.close();
    expect(existsSync(join(dir, "backups"))).toBe(false);
    const stopped = checkUpgrade(fixture.path);
    expect(stopped.ok).toBe(false);
    expect(stopped.report).toContain("Gemini");
  });

  it("includes committed data still in the WAL file in the backup", () => {
    const fixture = buildOldDatabase(dir);
    const writer = new Database(fixture.path);
    writer.pragma("wal_autocheckpoint = 0");
    writer
      .prepare(
        "INSERT INTO messages(room_id, sender_type, sender_id, body, created_at) VALUES (1, 'user', 'user', 'only in the WAL', ?)",
      )
      .run(NOW);
    expect(existsSync(`${fixture.path}-wal`)).toBe(true);
    const reader = new Database(fixture.path);
    const backup = backupBeforeUpgrade(reader, fixture.path, OLD_VERSION);
    reader.close();
    writer.close();
    const copy = new Database(backup.path, { readonly: true });
    expect(
      copy
        .prepare("SELECT body FROM messages WHERE body = 'only in the WAL'")
        .get(),
    ).toEqual({ body: "only in the WAL" });
    copy.close();
  });

  it("aborts when another connection writes between the backup and the upgrade", () => {
    const fixture = buildOldDatabase(dir);
    const db = new Database(fixture.path);
    const guard = backupBeforeUpgrade(
      db,
      fixture.path,
      OLD_VERSION,
    ).dataVersion;
    const other = new Database(fixture.path);
    other
      .prepare(
        "INSERT INTO messages(room_id, sender_type, sender_id, body, created_at) VALUES (1, 'user', 'user', 'late write', ?)",
      )
      .run(NOW);
    other.close();
    expect(() => migrate(db, SKILL_UPGRADE_VERSION, guard)).toThrow(
      ConcurrentUseError,
    );
    expect(db.pragma("user_version", { simple: true })).toBe(OLD_VERSION);
    db.close();
  });

  it("never overwrites a working folder that appeared after the database step, and retries safely", () => {
    const fixture = buildOldDatabase(dir);
    const db = openDatabase(fixture.path);
    try {
      const folder = join(fixture.skillsRoot, "konfab-dev-role");
      mkdirSync(folder);
      writeFileSync(join(folder, "SKILL.md"), "someone else's file");
      new SkillLibrary(db);
      expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(
        "someone else's file",
      );
      const state = () =>
        db
          .prepare(
            "SELECT o.state FROM skill_workspace_operations o JOIN skills s ON s.id = o.skill_id WHERE s.folder_name = 'konfab-dev-role'",
          )
          .get();
      expect(state()).toEqual({ state: "pending" });
      rmSync(folder, { recursive: true });
      new SkillLibrary(db);
      new SkillLibrary(db);
      expect(state()).toEqual({ state: "complete" });
      const files = readdirSync(folder).sort();
      expect(files).toEqual(["SKILL.md", "checklist.md"]);
      const current = db
        .prepare(
          "SELECT r.content_hash FROM skills s JOIN skill_revisions r ON r.id = s.current_revision_id WHERE s.folder_name = 'konfab-dev-role'",
        )
        .get() as { content_hash: string };
      expect(
        packageHash(
          files.map((path) => ({
            path,
            content: readFileSync(join(folder, path)),
            mode: 0o600,
          })),
        ),
      ).toBe(current.content_hash);
    } finally {
      db.close();
    }
  });
});
