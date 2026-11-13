import Database from "better-sqlite3";
import { createHash } from "node:crypto";
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

const OLD_VERSION = SKILL_UPGRADE_VERSION - 1;
const NOW = 1_700_000_000_000;

const options = {
  waitTimeoutSeconds: 1,
  turnTimeoutMs: 60 * 60_000,
  maxMessageChars: 10_000,
  now: () => Date.now(),
};

function blob(db: Db, content: string): string {
  const hash = createHash("sha256").update(content).digest("hex");
  db.prepare(
    "INSERT OR IGNORE INTO skill_blobs(hash, content) VALUES (?, ?)",
  ).run(hash, Buffer.from(content));
  return hash;
}

function roleMd(name: string, title: string, body: string): string {
  return `---\nname: ${name}\ntitle: ${title}\ndescription: ${title} duties\nskills: []\n---\n${body}`;
}

/** The role reply exactly as the pre-upgrade server built it. */
function oldEnvelope(
  db: Db,
  roleId: string,
  revisionId: string,
  notes: string,
): Record<string, unknown> {
  const revision = db
    .prepare("SELECT name, number, title FROM role_revisions WHERE id = ?")
    .get(revisionId) as { name: string; number: number; title: string };
  const manifest = db
    .prepare(
      "SELECT b.content FROM role_revision_files f JOIN skill_blobs b ON b.hash = f.blob_hash WHERE f.revision_id = ? AND f.path = 'ROLE.md'",
    )
    .get(revisionId) as { content: Buffer };
  const pins = db
    .prepare(
      `SELECT p.position, p.skill_id, p.skill_revision_id, r.name, r.description, 1 AS reviewed
       FROM role_revision_skills p JOIN skill_revisions r ON r.id = p.skill_revision_id
       WHERE p.role_revision_id = ? ORDER BY p.position`,
    )
    .all(revisionId) as Array<Record<string, unknown>>;
  return {
    id: roleId,
    revision_id: revisionId,
    name: revision.name,
    number: revision.number,
    changed: true,
    title: revision.title,
    notes,
    role_md: manifest.content.toString("utf8"),
    skills: pins.map((pin) => ({
      ...pin,
      files: db
        .prepare(
          "SELECT path FROM skill_revision_files WHERE revision_id = ? ORDER BY path",
        )
        .all(pin.skill_revision_id),
    })),
  };
}

interface Fixture {
  dir: string;
  path: string;
  skillsRoot: string;
}

/**
 * Builds a database at the last schema before the upgrade, with the data the
 * old server kept for roles, using that schema's own tables.
 */
function buildOldDatabase(
  dir: string,
  extra: { freeText?: string; bigRole?: number } = {},
): Fixture {
  const path = join(dir, "konfab.db");
  const skillsRoot = join(dir, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db, OLD_VERSION);
  db.transaction(() => {
    for (const id of ["claude", "codex", "gemini"]) {
      db.prepare(
        "INSERT INTO agents(id, display_name, created_at, app_id) VALUES (?, ?, ?, NULL)",
      ).run(id, id[0]!.toUpperCase() + id.slice(1), NOW);
    }
    db.prepare(
      "INSERT INTO rooms(id, name, created_at) VALUES (1, 'konfab-improvement', ?)",
    ).run(NOW);
    ["claude", "codex", "gemini"].forEach((id, position) =>
      db
        .prepare(
          "INSERT INTO room_members(room_id, agent_id, position, role) VALUES (1, ?, ?, ?)",
        )
        .run(
          id,
          position,
          id === "gemini" ? (extra.freeText ?? "Free text role") : "",
        ),
    );
    db.prepare(
      "INSERT INTO skill_libraries(id, kind, root_path, created_at) VALUES ('lib', 'personal', ?, ?)",
    ).run(skillsRoot, NOW);
    // A pinned helper skill with two reviewed revisions.
    db.prepare(
      "INSERT INTO skills(id, library_id, folder_name, current_revision_id, created_at) VALUES ('helper', 'lib', 'helper', 'helper-2', ?)",
    ).run(NOW);
    // An unrelated existing skill whose name collides with a role.
    db.prepare(
      "INSERT INTO skills(id, library_id, folder_name, current_revision_id, created_at) VALUES ('taken', 'lib', 'konfab-dev', 'taken-1', ?)",
    ).run(NOW);
    for (const [skill, id, number, name, body] of [
      ["helper", "helper-1", 1, "helper", "helper v1"],
      ["helper", "helper-2", 2, "helper", "helper v2"],
      ["taken", "taken-1", 1, "konfab-dev", "unrelated"],
    ] as const) {
      const manifest = `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`;
      const notes = `notes for ${id}`;
      db.prepare(
        "INSERT INTO skill_revisions(id, skill_id, number, content_hash, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, skill, number, `hash-${id}`, name, `${name} skill`, NOW);
      db.prepare(
        "INSERT INTO skill_revision_files(revision_id, path, blob_hash, mode) VALUES (?, 'SKILL.md', ?, 384)",
      ).run(id, blob(db, manifest));
      db.prepare(
        "INSERT INTO skill_revision_files(revision_id, path, blob_hash, mode) VALUES (?, 'notes.md', ?, 384)",
      ).run(id, blob(db, notes));
      db.prepare(
        "INSERT INTO skill_reviews(revision_id, reviewed_at) VALUES (?, ?)",
      ).run(id, NOW);
    }
    // Personal role konfab-dev, two revisions pinning different helper revisions.
    db.prepare(
      "INSERT INTO role_libraries(id, kind, root_path) VALUES ('personal', 'personal', ?)",
    ).run(join(dir, "roles"));
    db.prepare(
      "INSERT INTO role_libraries(id, kind, root_path) VALUES ('builtin', 'builtin', ?)",
    ).run(join(dir, "builtin-roles"));
    db.prepare(
      "INSERT INTO roles(id, library_id, folder_name, current_revision_id, created_at) VALUES ('role-dev', 'personal', 'konfab-dev', 'dev-2', ?)",
    ).run(NOW);
    db.prepare(
      "INSERT INTO roles(id, library_id, folder_name, current_revision_id, created_at) VALUES ('builtin:reviewer', 'builtin', 'reviewer', 'rev-1', ?)",
    ).run(NOW);
    const big = extra.bigRole ? "y".repeat(extra.bigRole) : "";
    for (const [role, id, number, name, title, body, pin] of [
      [
        "role-dev",
        "dev-1",
        1,
        "konfab-dev",
        "Konfab developer",
        "Develop v1",
        "helper-1",
      ],
      [
        "role-dev",
        "dev-2",
        2,
        "konfab-dev",
        "Konfab developer",
        `Develop v2${big}`,
        "helper-2",
      ],
      [
        "builtin:reviewer",
        "rev-1",
        1,
        "reviewer",
        "Reviewer",
        "Review things",
        null,
      ],
    ] as const) {
      db.prepare(
        "INSERT INTO role_revisions(id, role_id, number, content_hash, name, title, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        role,
        number,
        `role-${id}`,
        name,
        title,
        `${title} duties`,
        NOW,
      );
      db.prepare(
        "INSERT INTO role_revision_files(revision_id, path, blob_hash, mode) VALUES (?, 'ROLE.md', ?, 384)",
      ).run(id, blob(db, roleMd(name, title, body)));
      if (role === "role-dev")
        db.prepare(
          "INSERT INTO role_revision_files(revision_id, path, blob_hash, mode) VALUES (?, 'checklist.md', ?, 384)",
        ).run(id, blob(db, `checklist ${id}`));
      if (pin) {
        db.prepare(
          "INSERT INTO role_revision_skills(role_revision_id, position, skill_id, skill_revision_id) VALUES (?, 0, 'helper', ?)",
        ).run(id, pin);
        db.prepare(
          "INSERT INTO skill_usages(skill_id, revision_id, owner_type, owner_id, label) VALUES ('helper', ?, 'role_revision', ?, ?)",
        ).run(pin, id, `Role ${title} rev ${number}`);
      }
    }
    db.prepare(
      "INSERT INTO room_member_roles(room_id, agent_id, role_id, role_revision_id, notes, assigned_at, generation, delivered_generation) VALUES (1, 'claude', 'role-dev', 'dev-2', 'Room notes', ?, 2, 2)",
    ).run(NOW);
    db.prepare(
      "INSERT INTO room_member_roles(room_id, agent_id, role_id, role_revision_id, notes, assigned_at, generation, delivered_generation) VALUES (1, 'codex', 'builtin:reviewer', 'rev-1', '', ?, 1, 1)",
    ).run(NOW);
    // Claude is mid-turn: the turn started on dev-1, and the lead swapped to dev-2 since.
    for (const id of ["claude", "codex"])
      db.prepare(
        "INSERT INTO sessions(id, room_id, agent_id, state, started_at, last_call_at) VALUES (?, 1, ?, 'active', ?, ?)",
      ).run(`s-${id}`, id, Date.now(), Date.now());
    const started = JSON.stringify(
      oldEnvelope(db, "role-dev", "dev-1", "Room notes"),
    );
    db.prepare(
      "INSERT INTO turns(id, room_id, agent_id, reason, state, created_at, started_at, session_id, role_envelope_json, swap_role_snapshot_json, swap_role_text_snapshot) VALUES (1, 1, 'claude', 'user', 'active', ?, ?, 's-claude', ?, ?, '')",
    ).run(Date.now(), Date.now(), started, started);
  })();
  // A stray folder in the personal library with the built-in role's name.
  mkdirSync(join(skillsRoot, "reviewer"));
  writeFileSync(join(skillsRoot, "reviewer", "mine.txt"), "keep me");
  db.close();
  return { dir, path, skillsRoot };
}

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
