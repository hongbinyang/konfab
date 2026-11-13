import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, type Db } from "../../src/server/db/index.js";

/** The last schema version before roles were replaced by skills. */
export const OLD_VERSION = 32;
const NOW = 1_700_000_000_000;

/** Revision IDs are UUIDs, as in real databases; tests refer to them by label. */
export const ID = {
  "dev-1": "d0000000-0000-4000-8000-000000000001",
  "dev-2": "d0000000-0000-4000-8000-000000000002",
  "rev-1": "d0000000-0000-4000-8000-000000000003",
  "helper-1": "d0000000-0000-4000-8000-000000000004",
  "helper-2": "d0000000-0000-4000-8000-000000000005",
  "taken-1": "d0000000-0000-4000-8000-000000000006",
} as const;
const u = (label: keyof typeof ID) => ID[label];

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
export function oldEnvelope(
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

export interface Fixture {
  dir: string;
  path: string;
  skillsRoot: string;
}

/**
 * Builds a database at the last schema before the upgrade, with the data the
 * old server kept for roles, using that schema's own tables.
 */
export function buildOldDatabase(
  dir: string,
  extra: {
    freeText?: string;
    bigRole?: number;
    roleSkillFile?: boolean;
    snapshotText?: string;
  } = {},
): Fixture {
  const path = join(dir, "konfab.db");
  const skillsRoot = join(dir, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db, OLD_VERSION);
  db.transaction(() => {
    for (const id of ["claude", "codex", "gemini"]) {
      const name = id[0]!.toUpperCase() + id.slice(1);
      db.prepare(
        "INSERT INTO apps(id, display_name, token_hash, default_agent_id) VALUES (?, ?, NULL, ?)",
      ).run(id, name, id);
      db.prepare(
        "INSERT INTO agents(id, display_name, created_at, app_id) VALUES (?, ?, ?, ?)",
      ).run(id, name, NOW, id);
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
      "INSERT INTO skills(id, library_id, folder_name, current_revision_id, created_at) VALUES ('helper', 'lib', 'helper', ?, ?)",
    ).run(u("helper-2"), NOW);
    // An unrelated existing skill whose name collides with a role.
    db.prepare(
      "INSERT INTO skills(id, library_id, folder_name, current_revision_id, created_at) VALUES ('taken', 'lib', 'konfab-dev', ?, ?)",
    ).run(u("taken-1"), NOW);
    for (const [skill, id, number, name, body] of [
      ["helper", "helper-1", 1, "helper", "helper v1"],
      ["helper", "helper-2", 2, "helper", "helper v2"],
      ["taken", "taken-1", 1, "konfab-dev", "unrelated"],
    ] as const) {
      const manifest = `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`;
      const notes = `notes for ${id}`;
      db.prepare(
        "INSERT INTO skill_revisions(id, skill_id, number, content_hash, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(u(id), skill, number, `hash-${id}`, name, `${name} skill`, NOW);
      db.prepare(
        "INSERT INTO skill_revision_files(revision_id, path, blob_hash, mode) VALUES (?, 'SKILL.md', ?, 384)",
      ).run(u(id), blob(db, manifest));
      db.prepare(
        "INSERT INTO skill_revision_files(revision_id, path, blob_hash, mode) VALUES (?, 'notes.md', ?, 384)",
      ).run(u(id), blob(db, notes));
      db.prepare(
        "INSERT INTO skill_reviews(revision_id, reviewed_at) VALUES (?, ?)",
      ).run(u(id), NOW);
    }
    // Personal role konfab-dev, two revisions pinning different helper revisions.
    db.prepare(
      "INSERT INTO role_libraries(id, kind, root_path) VALUES ('personal', 'personal', ?)",
    ).run(join(dir, "roles"));
    db.prepare(
      "INSERT INTO role_libraries(id, kind, root_path) VALUES ('builtin', 'builtin', ?)",
    ).run(join(dir, "builtin-roles"));
    db.prepare(
      "INSERT INTO roles(id, library_id, folder_name, current_revision_id, created_at) VALUES ('role-dev', 'personal', 'konfab-dev', ?, ?)",
    ).run(u("dev-2"), NOW);
    db.prepare(
      "INSERT INTO roles(id, library_id, folder_name, current_revision_id, created_at) VALUES ('builtin:reviewer', 'builtin', 'reviewer', ?, ?)",
    ).run(u("rev-1"), NOW);
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
        u(id),
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
      ).run(u(id), blob(db, roleMd(name, title, body)));
      if (role === "role-dev")
        db.prepare(
          "INSERT INTO role_revision_files(revision_id, path, blob_hash, mode) VALUES (?, 'checklist.md', ?, 384)",
        ).run(u(id), blob(db, `checklist ${id}`));
      if (role === "role-dev" && extra.roleSkillFile)
        db.prepare(
          "INSERT INTO role_revision_files(revision_id, path, blob_hash, mode) VALUES (?, 'SKILL.md', ?, 384)",
        ).run(u(id), blob(db, `role's own SKILL.md for ${id}`));
      if (pin) {
        db.prepare(
          "INSERT INTO role_revision_skills(role_revision_id, position, skill_id, skill_revision_id) VALUES (?, 0, 'helper', ?)",
        ).run(u(id), u(pin));
        db.prepare(
          "INSERT INTO skill_usages(skill_id, revision_id, owner_type, owner_id, label) VALUES ('helper', ?, 'role_revision', ?, ?)",
        ).run(u(pin), u(id), `Role ${title} rev ${number}`);
      }
    }
    db.prepare(
      "INSERT INTO room_member_roles(room_id, agent_id, role_id, role_revision_id, notes, assigned_at, generation, delivered_generation) VALUES (1, 'claude', 'role-dev', ?, 'Room notes', ?, 2, 2)",
    ).run(u("dev-2"), NOW);
    db.prepare(
      "INSERT INTO room_member_roles(room_id, agent_id, role_id, role_revision_id, notes, assigned_at, generation, delivered_generation) VALUES (1, 'codex', 'builtin:reviewer', ?, '', ?, 1, 1)",
    ).run(u("rev-1"), NOW);
    // Claude is mid-turn: the turn started on dev-1, and the lead swapped to dev-2 since.
    for (const id of ["claude", "codex"])
      db.prepare(
        "INSERT INTO sessions(id, room_id, agent_id, state, started_at, last_call_at) VALUES (?, 1, ?, 'active', ?, ?)",
      ).run(`s-${id}`, id, Date.now(), Date.now());
    const started = JSON.stringify(
      oldEnvelope(db, "role-dev", u("dev-1"), "Room notes"),
    );
    db.prepare(
      "INSERT INTO turns(id, room_id, agent_id, reason, state, created_at, started_at, session_id, role_envelope_json, swap_role_snapshot_json, swap_role_text_snapshot) VALUES (1, 1, 'claude', 'user', 'active', ?, ?, 's-claude', ?, ?, ?)",
    ).run(Date.now(), Date.now(), started, started, extra.snapshotText ?? "");
  })();
  // A stray folder in the personal library with the built-in role's name.
  mkdirSync(join(skillsRoot, "reviewer"));
  writeFileSync(join(skillsRoot, "reviewer", "mine.txt"), "keep me");
  db.close();
  return { dir, path, skillsRoot };
}
