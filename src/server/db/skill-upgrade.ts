import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ASSIGNMENT_LIMIT_BYTES,
  assignmentBytes,
  fullAssignment,
  skillEntries,
  type DeliveredIdentity,
  type FullAssignment,
  type Pin,
  type TurnSnapshot,
} from "../domain/assignments.js";
import { packageHash, type SkillFile } from "../domain/skill-files.js";
import type { Db } from "./index.js";

/** Thrown when an assignment cannot be converted without losing content. Nothing is written. */
export class UpgradeStopped extends Error {}

const SCHEMA = `
  ALTER TABLE room_members RENAME COLUMN role TO instructions;
  ALTER TABLE room_members RENAME COLUMN role_assignment_revision TO assignment_revision;
  ALTER TABLE room_members ADD COLUMN legacy_role_revision_id TEXT;
  ALTER TABLE room_members ADD COLUMN upgrade_notice INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE room_members ADD COLUMN delivered_assignment_json TEXT NOT NULL DEFAULT '{"instructions":"","pins":[]}';
  ALTER TABLE turns ADD COLUMN reply_assignment_json TEXT;
  ALTER TABLE turns ADD COLUMN assignment_snapshot_json TEXT;
  CREATE TABLE room_member_skills (
    room_id INTEGER NOT NULL, agent_id TEXT NOT NULL, position INTEGER NOT NULL,
    skill_id TEXT NOT NULL, skill_revision_id TEXT NOT NULL,
    delivery TEXT NOT NULL DEFAULT 'full' CHECK(delivery IN ('full','summary')),
    PRIMARY KEY(room_id, agent_id, position), UNIQUE(room_id, agent_id, skill_id),
    FOREIGN KEY(room_id, agent_id) REFERENCES room_members(room_id, agent_id) ON DELETE CASCADE,
    FOREIGN KEY(skill_id, skill_revision_id) REFERENCES skill_revisions(skill_id, id)
  );
  CREATE TABLE legacy_role_revisions (
    role_revision_id TEXT PRIMARY KEY, role_id TEXT NOT NULL, name TEXT NOT NULL,
    title TEXT NOT NULL, number INTEGER NOT NULL, description TEXT NOT NULL,
    skill_id TEXT NOT NULL, skill_revision_id TEXT NOT NULL,
    FOREIGN KEY(skill_id, skill_revision_id) REFERENCES skill_revisions(skill_id, id)
  );
  CREATE TABLE legacy_role_files (
    role_revision_id TEXT NOT NULL REFERENCES legacy_role_revisions(role_revision_id),
    path TEXT NOT NULL, blob_hash TEXT NOT NULL REFERENCES skill_blobs(hash), mode INTEGER NOT NULL,
    PRIMARY KEY(role_revision_id, path)
  );
  ALTER TABLE skill_workspace_operations ADD COLUMN previous_revision_id TEXT REFERENCES skill_revisions(id);
  CREATE TABLE upgrade_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE skill_libraries_new (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('personal','project','builtin')),
    root_path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
  );
  INSERT INTO skill_libraries_new SELECT id, kind, root_path, created_at FROM skill_libraries;
  DROP TABLE skill_libraries;
  ALTER TABLE skill_libraries_new RENAME TO skill_libraries;
`;

const CLEANUP = `
  DELETE FROM skill_usages WHERE owner_type = 'role_revision';
  ALTER TABLE room_members DROP COLUMN delivered_role_identity;
  ALTER TABLE room_members DROP COLUMN delivered_role_label;
  ALTER TABLE turns DROP COLUMN role_envelope_json;
  ALTER TABLE turns DROP COLUMN swap_role_snapshot_json;
  ALTER TABLE turns DROP COLUMN swap_role_text_snapshot;
  DROP TABLE converted_role_history;
  DROP TABLE role_workspace_operations;
  DROP TABLE room_member_roles;
  DROP TABLE role_revision_skills;
  DROP TABLE role_revision_files;
  DROP TABLE roles;
  DROP TABLE role_revisions;
  DROP TABLE role_libraries;
`;

interface RoleRevision {
  id: string;
  role_id: string;
  number: number;
  name: string;
  title: string;
  description: string;
  folder_name: string;
}

interface OldPin {
  skill_id: string;
  skill_revision_id: string;
}

interface OldEnvelope {
  revision_id?: string;
  notes?: string;
  role_md?: string;
  skills?: OldPin[];
  reminder?: string;
}

/**
 * Replaces role assignments with skill assignments. Runs inside the migration
 * transaction: it reads and writes only the database (plus creating the
 * personal skill folder root if needed), so a failure leaves nothing behind.
 */
export function upgradeRolesToSkills(db: Db, now = Date.now()): void {
  const memberRoles = db
    .prepare(
      "SELECT room_id, agent_id, role_revision_id, notes FROM room_member_roles",
    )
    .all() as {
    room_id: number;
    agent_id: string;
    role_revision_id: string;
    notes: string;
  }[];
  const activeTurns = db
    .prepare(
      "SELECT id, room_id, agent_id, role_envelope_json, swap_role_snapshot_json, swap_role_text_snapshot FROM turns WHERE state = 'active'",
    )
    .all() as {
    id: number;
    room_id: number;
    agent_id: string;
    role_envelope_json: string | null;
    swap_role_snapshot_json: string | null;
    swap_role_text_snapshot: string | null;
  }[];
  const parse = (json: string | null): OldEnvelope | null => {
    if (!json) return null;
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" ? (value as OldEnvelope) : null;
  };

  // 1. Every role revision still in use, by a member or by an active turn.
  const needed = new Set(memberRoles.map((row) => row.role_revision_id));
  for (const turn of activeTurns)
    for (const envelope of [
      parse(turn.role_envelope_json),
      parse(turn.swap_role_snapshot_json),
    ])
      if (envelope?.revision_id) needed.add(envelope.revision_id);

  db.exec(SCHEMA);

  const revisions = (
    db
      .prepare(
        `SELECT r.id, r.role_id, r.number, r.name, r.title, r.description, o.folder_name
         FROM role_revisions r JOIN roles o ON o.id = r.role_id ORDER BY r.role_id, r.number`,
      )
      .all() as RoleRevision[]
  ).filter((revision) => needed.has(revision.id));

  // 2. Convert each role (with its needed revisions) into one personal skill.
  const converted = new Map<
    string,
    { skill_id: string; revision_id: string }
  >();
  if (revisions.length) {
    const library = personalLibrary(db, now);
    const byRole = new Map<string, RoleRevision[]>();
    for (const revision of revisions)
      byRole.set(revision.role_id, [
        ...(byRole.get(revision.role_id) ?? []),
        revision,
      ]);
    for (const list of byRole.values()) {
      const name = freeName(db, library, list[0]!.folder_name);
      const skillId = randomUUID();
      const ids = list.map(() => randomUUID());
      db.prepare(
        "INSERT INTO skills(id, library_id, folder_name, current_revision_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(skillId, library.id, name, ids[ids.length - 1], now);
      list.forEach((revision, index) => {
        const skillRevision = ids[index]!;
        convertRevision(
          db,
          revision,
          skillId,
          skillRevision,
          name,
          index + 1,
          now,
        );
        converted.set(revision.id, {
          skill_id: skillId,
          revision_id: skillRevision,
        });
      });
      db.prepare(
        "INSERT INTO skill_workspace_operations(skill_id, revision_id, state, created_at) VALUES (?, ?, 'pending', ?)",
      ).run(skillId, ids[ids.length - 1], now);
      log(
        db,
        "converted_role",
        `Role ${list[0]!.title} became the personal skill ${name}`,
        now,
      );
    }
  }

  const rolePins = (roleRevisionId: string, extra?: OldPin[]): Pin[] => {
    const own = converted.get(roleRevisionId)!;
    const others =
      extra ??
      (db
        .prepare(
          "SELECT skill_id, skill_revision_id FROM role_revision_skills WHERE role_revision_id = ? ORDER BY position",
        )
        .all(roleRevisionId) as OldPin[]);
    return [
      {
        skill_id: own.skill_id,
        revision_id: own.revision_id,
        delivery: "full",
      },
      ...others.map((pin) => ({
        skill_id: pin.skill_id,
        revision_id: pin.skill_revision_id,
        delivery: "summary" as const,
      })),
    ];
  };
  const fit = (instructions: string, pins: Pin[]): Pin[] | null => {
    if (assignmentBytes(db, instructions, pins) <= ASSIGNMENT_LIMIT_BYTES)
      return pins;
    const summaries = pins.map((pin) => ({
      ...pin,
      delivery: "summary" as const,
    }));
    if (assignmentBytes(db, instructions, summaries) <= ASSIGNMENT_LIMIT_BYTES)
      return summaries;
    return null;
  };
  const joinText = (...parts: Array<string | null | undefined>) =>
    parts
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .join("\n\n");

  // 3–5. Members: pins, instructions, legacy contract and a one-time notice.
  const members = db
    .prepare(
      `SELECT m.room_id, m.agent_id, m.instructions, m.assignment_revision, r.name AS room_name, a.display_name
       FROM room_members m JOIN rooms r ON r.id = m.room_id JOIN agents a ON a.id = m.agent_id`,
    )
    .all() as {
    room_id: number;
    agent_id: string;
    instructions: string;
    assignment_revision: number;
    room_name: string;
    display_name: string;
  }[];
  const roleOf = new Map(
    memberRoles.map((row) => [`${row.room_id}:${row.agent_id}`, row]),
  );
  const tooLarge: string[] = [];
  const insertPin = db.prepare(
    "INSERT INTO room_member_skills(room_id, agent_id, position, skill_id, skill_revision_id, delivery) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const usage = db.prepare(
    "INSERT OR IGNORE INTO skill_usages(skill_id, revision_id, owner_type, owner_id, label) VALUES (?, ?, ?, ?, ?)",
  );
  for (const member of members) {
    const key = `${member.room_id}:${member.agent_id}`;
    const role = roleOf.get(key);
    const instructions = joinText(member.instructions, role?.notes);
    const wanted = role ? rolePins(role.role_revision_id) : [];
    const fitted = fit(instructions, wanted);
    if (!fitted) {
      tooLarge.push(
        `Room "${member.room_name}", ${member.display_name}: instructions ${Buffer.byteLength(instructions)} bytes and ${wanted.length} skills still exceed ${ASSIGNMENT_LIMIT_BYTES / 1024} KiB as summaries`,
      );
      continue;
    }
    const pins = fitted;
    if (role) {
      if (fitted[0]!.delivery === "summary")
        log(
          db,
          "summary_to_fit",
          `Room "${member.room_name}", ${member.display_name}: delivered as summary to fit`,
          now,
        );
    }
    pins.forEach((pin, index) =>
      insertPin.run(
        member.room_id,
        member.agent_id,
        index + 1,
        pin.skill_id,
        pin.revision_id,
        pin.delivery,
      ),
    );
    for (const pin of pins)
      usage.run(
        pin.skill_id,
        pin.revision_id,
        "assignment",
        key,
        `Room ${member.room_name} · ${member.display_name}`,
      );
    const identity = identityOf(db, instructions, pins);
    db.prepare(
      "UPDATE room_members SET instructions = ?, legacy_role_revision_id = ?, upgrade_notice = ?, delivered_assignment_json = ? WHERE room_id = ? AND agent_id = ?",
    ).run(
      instructions,
      role?.role_revision_id ?? null,
      role || instructions ? 1 : 0,
      JSON.stringify(identity),
      member.room_id,
      member.agent_id,
    );
  }
  if (tooLarge.length)
    throw new UpgradeStopped(
      `Konfab could not convert these roles to skills without losing content:\n- ${tooLarge.join("\n- ")}\nStart the previous Konfab version, shorten this member's notes or role text, or remove pinned skills, then upgrade again.`,
    );

  // 6. Active turns keep their exact replies and get an equivalent snapshot.
  for (const turn of activeTurns) {
    const reply = parse(turn.role_envelope_json);
    const swap = turn.swap_role_snapshot_json;
    const member = db
      .prepare(
        "SELECT assignment_revision, instructions FROM room_members WHERE room_id = ? AND agent_id = ?",
      )
      .get(turn.room_id, turn.agent_id) as {
      assignment_revision: number;
      instructions: string;
    };
    const build = (
      envelope: OldEnvelope | null,
      text: string | null,
    ): FullAssignment => {
      const instructions = joinText(text, envelope?.notes);
      const pins =
        envelope?.revision_id && converted.has(envelope.revision_id)
          ? (fit(
              instructions,
              rolePins(envelope.revision_id, envelope.skills),
            ) ?? rolePins(envelope.revision_id, envelope.skills))
          : [];
      return fullAssignment(db, member.assignment_revision, instructions, pins);
    };
    if (turn.role_envelope_json !== null) {
      const assignment = reply?.role_md
        ? build(reply, null)
        : reply?.reminder
          ? {
              revision: member.assignment_revision,
              changed: false as const,
              reminder:
                "Your assignment is unchanged; call read_role (or read_assignment) to re-read it.",
            }
          : null;
      db.prepare("UPDATE turns SET reply_assignment_json = ? WHERE id = ?").run(
        JSON.stringify({
          role: JSON.parse(turn.role_envelope_json) as unknown,
          ...(assignment ? { assignment } : {}),
        }),
        turn.id,
      );
    }
    if (swap !== null) {
      const legacy = parse(swap);
      const snapshot: TurnSnapshot = {
        assignment: build(legacy, turn.swap_role_text_snapshot),
        ...(legacy?.revision_id
          ? {
              legacy_role: JSON.parse(swap) as TurnSnapshot["legacy_role"],
            }
          : {}),
      };
      db.prepare(
        "UPDATE turns SET assignment_snapshot_json = ? WHERE id = ?",
      ).run(JSON.stringify(snapshot), turn.id);
      for (const skill of snapshot.assignment.skills)
        usage.run(
          skill.skill_id,
          skill.revision_id,
          "turn",
          String(turn.id),
          "An agent's current turn",
        );
    }
  }

  db.exec(CLEANUP);
}

function identityOf(
  db: Db,
  instructions: string,
  pins: Pin[],
): DeliveredIdentity {
  return {
    instructions,
    pins: skillEntries(db, pins).map((entry) => ({
      skill_id: entry.skill_id,
      revision_id: entry.revision_id,
      delivery: entry.delivery,
      name: entry.name,
      number: entry.number,
    })),
  };
}

function personalLibrary(db: Db, now: number): { id: string; root: string } {
  const existing = db
    .prepare(
      "SELECT id, root_path FROM skill_libraries WHERE kind = 'personal' ORDER BY created_at LIMIT 1",
    )
    .get() as { id: string; root_path: string } | undefined;
  if (existing) return { id: existing.id, root: existing.root_path };
  if (!db.name || db.name === ":memory:")
    throw new UpgradeStopped(
      "Konfab needs a personal skill library to convert roles; none is available for an in-memory database.",
    );
  const root = join(dirname(db.name), "skills");
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(root);
  const id = randomUUID();
  db.prepare(
    "INSERT INTO skill_libraries(id, kind, root_path, created_at) VALUES (?, 'personal', ?, ?)",
  ).run(id, canonical, now);
  return { id, root: canonical };
}

/** A folder name that no skill row or folder in the library uses yet. */
function freeName(
  db: Db,
  library: { id: string; root: string },
  base: string,
): string {
  const taken = (name: string) =>
    !!db
      .prepare("SELECT 1 FROM skills WHERE library_id = ? AND folder_name = ?")
      .get(library.id, name) || existsSync(join(library.root, name));
  if (!taken(base)) return base;
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `${base}-role` : `${base}-role-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

function convertRevision(
  db: Db,
  revision: RoleRevision,
  skillId: string,
  skillRevisionId: string,
  name: string,
  number: number,
  now: number,
): void {
  const files = db
    .prepare(
      `SELECT f.path, f.mode, f.blob_hash, b.content FROM role_revision_files f
       JOIN skill_blobs b ON b.hash = f.blob_hash WHERE f.revision_id = ? ORDER BY f.path`,
    )
    .all(revision.id) as Array<SkillFile & { blob_hash: string }>;
  const manifest = files.find((file) => file.path === "ROLE.md");
  const text = manifest ? manifest.content.toString("utf8") : "";
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const skillMd = Buffer.from(
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(revision.description)}\n---\n${body}`,
  );
  const skillFiles: SkillFile[] = [
    { path: "SKILL.md", content: skillMd, mode: 0o600 },
    ...files
      .filter((file) => file.path !== "ROLE.md" && file.path !== "SKILL.md")
      .map(({ path, content, mode }) => ({ path, content, mode })),
  ];
  db.prepare(
    "INSERT INTO skill_revisions(id, skill_id, number, content_hash, name, description, provenance_json, licence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
  ).run(
    skillRevisionId,
    skillId,
    number,
    packageHash(skillFiles),
    name,
    revision.description,
    JSON.stringify({
      converted_from_role: {
        id: revision.role_id,
        revision_id: revision.id,
        title: revision.title,
        number: revision.number,
      },
    }),
    now,
  );
  const blob = db.prepare(
    "INSERT OR IGNORE INTO skill_blobs(hash, content) VALUES (?, ?)",
  );
  const ref = db.prepare(
    "INSERT INTO skill_revision_files(revision_id, path, blob_hash, mode) VALUES (?, ?, ?, ?)",
  );
  for (const file of skillFiles) {
    const hash = createHash("sha256").update(file.content).digest("hex");
    blob.run(hash, file.content);
    ref.run(skillRevisionId, file.path, hash, file.mode);
  }
  db.prepare(
    "INSERT INTO skill_reviews(revision_id, reviewed_at) VALUES (?, ?)",
  ).run(skillRevisionId, now);
  db.prepare(
    "INSERT INTO legacy_role_revisions(role_revision_id, role_id, name, title, number, description, skill_id, skill_revision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    revision.id,
    revision.role_id,
    revision.name,
    revision.title,
    revision.number,
    revision.description,
    skillId,
    skillRevisionId,
  );
  const legacyFile = db.prepare(
    "INSERT INTO legacy_role_files(role_revision_id, path, blob_hash, mode) VALUES (?, ?, ?, ?)",
  );
  for (const file of files)
    legacyFile.run(revision.id, file.path, file.blob_hash, file.mode);
}

function log(db: Db, kind: string, detail: string, now: number): void {
  db.prepare(
    "INSERT INTO upgrade_log(kind, detail, created_at) VALUES (?, ?, ?)",
  ).run(kind, detail, now);
}
