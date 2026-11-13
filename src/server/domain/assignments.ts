import type { Db } from "../db/index.js";
import { KonfabError } from "./errors.js";
import { fileChunk } from "./file-chunk.js";

/** Largest assignment, as JSON, that an agent receives in one reply. */
export const ASSIGNMENT_LIMIT_BYTES = 64 * 1024;

export const PRECEDENCE =
  "Room rules and the lead's instructions come first, then your room instructions, then your skills in the order listed. If two skills conflict, follow the earlier one and mention the conflict to the lead.";

export const REMINDER =
  "Your assignment is unchanged; call read_role (or read_assignment) to re-read it.";

export const SUMMARY_NOTE =
  "Only this skill's summary is included. Read its SKILL.md with read_skill_file before relying on it.";

export type Delivery = "full" | "summary";

export interface Pin {
  skill_id: string;
  revision_id: string;
  delivery: Delivery;
}

export interface SkillEntry {
  position: number;
  skill_id: string;
  revision_id: string;
  name: string;
  number: number;
  description: string;
  delivery: Delivery;
  reviewed: boolean;
  files: string[];
  skill_md?: string;
  read_first?: string;
}

export interface FullAssignment {
  revision: number;
  changed: true;
  notice?: string;
  precedence: string;
  instructions: string;
  skills: SkillEntry[];
}

export interface AssignmentReminder {
  revision: number;
  changed: false;
  reminder: string;
  notice?: string;
}

export type AssignmentEnvelope = FullAssignment | AssignmentReminder;

/** The fields an agent reply carries for its assignment. */
export interface AssignmentReply {
  assignment?: AssignmentEnvelope | null;
  role?: unknown;
}

/** What a member last received, used to describe changes. */
export interface DeliveredIdentity {
  instructions: string;
  pins: Array<Pin & { name: string; number: number }>;
}

export function envelopeBytes(envelope: unknown): number {
  return Buffer.byteLength(JSON.stringify(envelope));
}

export function tooLarge(bytes: number): KonfabError {
  const kib = Math.ceil(bytes / 1024);
  return new KonfabError(
    "assignment_too_large",
    413,
    `These skills total ${kib} KiB; agents can receive up to ${ASSIGNMENT_LIMIT_BYTES / 1024} KiB. Switch a skill to Send summary, remove one, or move long material out of SKILL.md into supporting files.`,
  );
}

/** Reads the details of pinned skill revisions in order. Unknown revisions throw. */
export function skillEntries(db: Db, pins: Pin[]): SkillEntry[] {
  const revision = db.prepare(
    `SELECT r.id, r.skill_id, r.number, r.name, r.description,
       CASE WHEN v.revision_id IS NULL THEN 0 ELSE 1 END AS reviewed
     FROM skill_revisions r LEFT JOIN skill_reviews v ON v.revision_id = r.id
     WHERE r.id = ? AND r.skill_id = ?`,
  );
  const files = db.prepare(
    "SELECT path FROM skill_revision_files WHERE revision_id = ? ORDER BY path",
  );
  const manifest = db.prepare(
    `SELECT b.content FROM skill_revision_files f JOIN skill_blobs b ON b.hash = f.blob_hash
     WHERE f.revision_id = ? AND f.path = 'SKILL.md'`,
  );
  return pins.map((pin, index) => {
    const row = revision.get(pin.revision_id, pin.skill_id) as
      | {
          id: string;
          skill_id: string;
          number: number;
          name: string;
          description: string;
          reviewed: number;
        }
      | undefined;
    if (!row)
      throw new KonfabError(
        "skill_unavailable",
        409,
        "A selected skill revision is unavailable; refresh and try again.",
      );
    const entry: SkillEntry = {
      position: index + 1,
      skill_id: row.skill_id,
      revision_id: row.id,
      name: row.name,
      number: row.number,
      description: row.description,
      delivery: pin.delivery,
      reviewed: row.reviewed === 1,
      files: (files.all(row.id) as { path: string }[]).map((f) => f.path),
    };
    if (pin.delivery === "full") {
      const content = manifest.get(row.id) as { content: Buffer } | undefined;
      entry.skill_md = content ? content.content.toString("utf8") : "";
    } else entry.read_first = SUMMARY_NOTE;
    return entry;
  });
}

export function fullAssignment(
  db: Db,
  revision: number,
  instructions: string,
  pins: Pin[],
  notice?: string,
): FullAssignment {
  return {
    revision,
    changed: true,
    ...(notice ? { notice } : {}),
    precedence: PRECEDENCE,
    instructions,
    skills: skillEntries(db, pins),
  };
}

/** Size of the full assignment for these pins, in bytes. */
export function assignmentBytes(
  db: Db,
  instructions: string,
  pins: Pin[],
): number {
  // Measure with a long notice so later notices cannot push a fitting assignment over the limit.
  return envelopeBytes(
    fullAssignment(
      db,
      Number.MAX_SAFE_INTEGER,
      instructions,
      pins,
      NOTICE_ROOM,
    ),
  );
}

/** Largest notice, as JSON, that a reply can carry; size checks reserve this much. */
export const NOTICE_LIMIT_BYTES = 2048;
const NOTICE_ROOM = "x".repeat(NOTICE_LIMIT_BYTES - 2);

/** Shortens a notice so that, as JSON, it never exceeds NOTICE_LIMIT_BYTES. */
export function clipNotice(text: string): string {
  if (envelopeBytes(text) <= NOTICE_LIMIT_BYTES) return text;
  let chars = [...text];
  while (
    chars.length &&
    envelopeBytes(`${chars.join("")}…`) > NOTICE_LIMIT_BYTES
  )
    chars = chars.slice(
      0,
      Math.max(0, chars.length - Math.max(1, chars.length >> 4)),
    );
  return `${chars.join("")}…`;
}

export function checkSize(db: Db, instructions: string, pins: Pin[]): void {
  const bytes = assignmentBytes(db, instructions, pins);
  if (bytes > ASSIGNMENT_LIMIT_BYTES) throw tooLarge(bytes);
}

/** Describes the change between what a member last received and its new assignment. */
export function changeNotice(
  before: DeliveredIdentity,
  after: DeliveredIdentity,
): string | null {
  const key = (pins: DeliveredIdentity["pins"]) =>
    JSON.stringify(pins.map((p) => [p.revision_id, p.delivery]));
  const skillsSame = key(before.pins) === key(after.pins);
  if (skillsSame && before.instructions === after.instructions) return null;
  const hadAny = before.pins.length > 0 || before.instructions.trim() !== "";
  const hasAny = after.pins.length > 0 || after.instructions.trim() !== "";
  if (!hadAny)
    return "You have been given an assignment. Read your room instructions and skills before continuing.";
  if (!hasAny)
    return "Your assignment was removed. Stop its duties and hand over open work, branches, reviews and pending pushes.";
  if (skillsSame)
    return after.instructions.trim()
      ? "Your room instructions changed; read them in your assignment. Your skills remain the same."
      : "Your room instructions were removed. Your skills remain the same.";
  const label = (p: { name: string; number: number }) =>
    `${p.name} rev ${p.number}`;
  // Name at most a few skills per kind of change; the assignment lists them all.
  const names = <T>(items: T[], format: (item: T) => string) =>
    items.length > 5
      ? `${items.slice(0, 5).map(format).join(", ")} and ${items.length - 5} more`
      : items.map(format).join(", ");
  const beforeBySkill = new Map(before.pins.map((p) => [p.skill_id, p]));
  const afterBySkill = new Map(after.pins.map((p) => [p.skill_id, p]));
  const parts: string[] = [];
  const added = after.pins.filter((p) => !beforeBySkill.has(p.skill_id));
  const removed = before.pins.filter((p) => !afterBySkill.has(p.skill_id));
  const updated = after.pins.filter((p) => {
    const old = beforeBySkill.get(p.skill_id);
    return old && old.revision_id !== p.revision_id;
  });
  if (added.length) parts.push(`added ${names(added, label)}`);
  if (removed.length) parts.push(`removed ${names(removed, label)}`);
  if (updated.length)
    parts.push(
      `updated ${names(
        updated,
        (p) =>
          `${p.name} rev ${beforeBySkill.get(p.skill_id)!.number} → rev ${p.number}`,
      )}`,
    );
  const order = (pins: DeliveredIdentity["pins"]) =>
    pins
      .filter(
        (p) => beforeBySkill.has(p.skill_id) && afterBySkill.has(p.skill_id),
      )
      .map((p) => p.skill_id)
      .join();
  if (order(before.pins) !== order(after.pins)) parts.push("reordered");
  if (!parts.length) parts.push("changed how skills are delivered");
  if (before.instructions !== after.instructions)
    parts.push("room instructions changed");
  return clipNotice(
    `Your skills changed: ${parts.join("; ")}. Stop duties you no longer have, read your assignment, and hand over open work if your responsibilities moved.`,
  );
}

export interface MemberAssignment {
  revision: number;
  instructions: string;
  pins: Pin[];
  legacy_role_revision_id: string | null;
}

export class AssignmentStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  current(roomId: number, agentId: string): MemberAssignment {
    const member = this.db
      .prepare(
        "SELECT assignment_revision, instructions, legacy_role_revision_id FROM room_members WHERE room_id = ? AND agent_id = ?",
      )
      .get(roomId, agentId) as
      | {
          assignment_revision: number;
          instructions: string;
          legacy_role_revision_id: string | null;
        }
      | undefined;
    if (!member)
      throw new KonfabError("not_member", 404, "Agent is not a room member");
    return {
      revision: member.assignment_revision,
      instructions: member.instructions,
      legacy_role_revision_id: member.legacy_role_revision_id,
      pins: this.pins(roomId, agentId),
    };
  }

  pins(roomId: number, agentId: string): Pin[] {
    return this.db
      .prepare(
        "SELECT skill_id, skill_revision_id AS revision_id, delivery FROM room_member_skills WHERE room_id = ? AND agent_id = ? ORDER BY position",
      )
      .all(roomId, agentId) as Pin[];
  }

  identity(instructions: string, pins: Pin[]): DeliveredIdentity {
    const entries = skillEntries(this.db, pins);
    return {
      instructions,
      pins: entries.map((e) => ({
        skill_id: e.skill_id,
        revision_id: e.revision_id,
        delivery: e.delivery,
        name: e.name,
        number: e.number,
      })),
    };
  }

  /** The member's full assignment, or null when it has no skills and no instructions. */
  full(
    roomId: number,
    agentId: string,
    notice?: string,
  ): FullAssignment | null {
    const current = this.current(roomId, agentId);
    if (!current.pins.length && !current.instructions.trim()) return null;
    return fullAssignment(
      this.db,
      current.revision,
      current.instructions,
      current.pins,
      notice,
    );
  }

  /** Validates and writes a member's assignment. Call inside a transaction. */
  write(
    roomId: number,
    agentId: string,
    input: { instructions: string; pins: Pin[]; review?: string[] },
    label: string,
  ): void {
    const ids = input.pins.map((pin) => pin.skill_id);
    if (new Set(ids).size !== ids.length)
      throw new KonfabError(
        "invalid_assignment",
        400,
        "Each skill can be assigned once.",
      );
    const review = new Set(input.review ?? []);
    for (const pin of input.pins) {
      const row = this.db
        .prepare(
          `SELECT s.trashed_at, CASE WHEN v.revision_id IS NULL THEN 0 ELSE 1 END AS reviewed
           FROM skills s JOIN skill_revisions r ON r.skill_id = s.id
           LEFT JOIN skill_reviews v ON v.revision_id = r.id
           WHERE s.id = ? AND r.id = ?`,
        )
        .get(pin.skill_id, pin.revision_id) as
        { trashed_at: number | null; reviewed: number } | undefined;
      if (!row || row.trashed_at !== null)
        throw new KonfabError(
          "skill_unavailable",
          409,
          "A selected skill is unavailable; refresh and try again.",
        );
      if (!row.reviewed && !review.has(pin.revision_id))
        throw new KonfabError(
          "skill_unreviewed",
          409,
          "Review each selected skill revision before assigning it.",
        );
    }
    checkSize(this.db, input.instructions, input.pins);
    this.snapshotActiveTurn(roomId, agentId);
    for (const pin of input.pins)
      if (review.has(pin.revision_id))
        this.db
          .prepare(
            "INSERT OR IGNORE INTO skill_reviews(revision_id, reviewed_at) VALUES (?, ?)",
          )
          .run(pin.revision_id, this.now());
    this.db
      .prepare(
        "DELETE FROM room_member_skills WHERE room_id = ? AND agent_id = ?",
      )
      .run(roomId, agentId);
    const insert = this.db.prepare(
      "INSERT INTO room_member_skills(room_id, agent_id, position, skill_id, skill_revision_id, delivery) VALUES (?, ?, ?, ?, ?, ?)",
    );
    input.pins.forEach((pin, index) =>
      insert.run(
        roomId,
        agentId,
        index + 1,
        pin.skill_id,
        pin.revision_id,
        pin.delivery,
      ),
    );
    this.writeUsages(roomId, agentId, input.pins, label);
    this.db
      .prepare(
        "UPDATE room_members SET instructions = ?, assignment_revision = assignment_revision + 1, legacy_role_revision_id = NULL WHERE room_id = ? AND agent_id = ?",
      )
      .run(input.instructions.trim(), roomId, agentId);
  }

  private writeUsages(
    roomId: number,
    agentId: string,
    pins: Pin[],
    label: string,
  ): void {
    const owner = `${roomId}:${agentId}`;
    this.db
      .prepare(
        "DELETE FROM skill_usages WHERE owner_type = 'assignment' AND owner_id = ?",
      )
      .run(owner);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO skill_usages(skill_id, revision_id, owner_type, owner_id, label) VALUES (?, ?, 'assignment', ?, ?)",
    );
    for (const pin of pins)
      insert.run(pin.skill_id, pin.revision_id, owner, label);
  }

  /** Keeps an active turn's current assignment for the rest of that turn. */
  snapshotActiveTurn(roomId: number, agentId: string): void {
    const active = this.db
      .prepare(
        "SELECT id, assignment_snapshot_json FROM turns WHERE room_id = ? AND agent_id = ? AND state = 'active'",
      )
      .get(roomId, agentId) as
      { id: number; assignment_snapshot_json: string | null } | undefined;
    if (!active || active.assignment_snapshot_json !== null) return;
    const current = this.current(roomId, agentId);
    const snapshot: TurnSnapshot = {
      assignment: fullAssignment(
        this.db,
        current.revision,
        current.instructions,
        current.pins,
      ),
      legacy_role: current.legacy_role_revision_id
        ? this.legacyRole(roomId, agentId, true)
        : undefined,
    };
    this.db
      .prepare("UPDATE turns SET assignment_snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify(snapshot), active.id);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO skill_usages(skill_id, revision_id, owner_type, owner_id, label) VALUES (?, ?, 'turn', ?, ?)",
    );
    for (const pin of current.pins)
      insert.run(
        pin.skill_id,
        pin.revision_id,
        String(active.id),
        "An agent's current turn",
      );
  }

  /** The active turn's snapshot for this session, if the assignment changed during it. */
  turnSnapshot(
    roomId: number,
    agentId: string,
    sessionId: string,
  ): TurnSnapshot | null {
    const row = this.db
      .prepare(
        "SELECT assignment_snapshot_json FROM turns WHERE room_id = ? AND agent_id = ? AND session_id = ? AND state = 'active'",
      )
      .get(roomId, agentId, sessionId) as
      { assignment_snapshot_json: string | null } | undefined;
    return row?.assignment_snapshot_json
      ? (JSON.parse(row.assignment_snapshot_json) as TurnSnapshot)
      : null;
  }

  /** The pre-upgrade role reply for a converted member whose assignment has not changed since. */
  legacyRole(
    roomId: number,
    agentId: string,
    full: boolean,
  ): LegacyRole | undefined {
    const current = this.current(roomId, agentId);
    if (!current.legacy_role_revision_id) return undefined;
    const legacy = this.db
      .prepare(
        "SELECT role_id, role_revision_id, name, title, number, skill_id FROM legacy_role_revisions WHERE role_revision_id = ?",
      )
      .get(current.legacy_role_revision_id) as
      | {
          role_id: string;
          role_revision_id: string;
          name: string;
          title: string;
          number: number;
          skill_id: string;
        }
      | undefined;
    if (!legacy) return undefined;
    const base = {
      id: legacy.role_id,
      revision_id: legacy.role_revision_id,
      name: legacy.name,
      number: legacy.number,
    };
    if (!full)
      return {
        ...base,
        changed: false,
        reminder:
          "Your pinned role remains active; call read_role to re-read it.",
      };
    const manifest = this.db
      .prepare(
        `SELECT b.content FROM legacy_role_files f JOIN skill_blobs b ON b.hash = f.blob_hash
         WHERE f.role_revision_id = ? AND f.path = 'ROLE.md'`,
      )
      .get(legacy.role_revision_id) as { content: Buffer } | undefined;
    const others = current.pins.filter(
      (pin) => pin.skill_id !== legacy.skill_id,
    );
    const entries = skillEntries(this.db, others);
    return {
      ...base,
      changed: true,
      title: legacy.title,
      notes: current.instructions,
      role_md: manifest ? manifest.content.toString("utf8") : "",
      skills: entries.map((entry, index) => ({
        position: index,
        skill_id: entry.skill_id,
        skill_revision_id: entry.revision_id,
        name: entry.name,
        description: entry.description,
        reviewed: entry.reviewed ? 1 : 0,
        files: entry.files.map((path) => ({ path })),
      })),
    };
  }

  /** Reads a supporting file of a skill in the caller's assignment or turn snapshot. */
  readSkillFile(
    roomId: number,
    agentId: string,
    sessionId: string,
    revisionId: string,
    path: string,
    offset: number,
    max: number,
  ) {
    const snapshot = this.turnSnapshot(roomId, agentId, sessionId);
    const allowed = snapshot
      ? snapshot.assignment.skills.some((s) => s.revision_id === revisionId)
      : this.pins(roomId, agentId).some((p) => p.revision_id === revisionId);
    if (!allowed)
      throw new KonfabError("forbidden", 403, "Skill file is not assigned");
    const row = this.db
      .prepare(
        `SELECT b.content FROM skill_revision_files f JOIN skill_blobs b ON b.hash = f.blob_hash
         WHERE f.revision_id = ? AND f.path = ?`,
      )
      .get(revisionId, path) as { content: Buffer } | undefined;
    if (!row)
      throw new KonfabError("forbidden", 403, "Skill file is not assigned");
    return fileChunk(row.content, offset, max);
  }

  /** Reads an original role file for a converted role the caller still uses. */
  readLegacyRoleFile(
    roomId: number,
    agentId: string,
    sessionId: string,
    roleRevisionId: string,
    path: string,
    offset: number,
    max: number,
  ) {
    const snapshot = this.turnSnapshot(roomId, agentId, sessionId);
    const allowed = snapshot
      ? snapshot.legacy_role?.revision_id === roleRevisionId
      : this.current(roomId, agentId).legacy_role_revision_id ===
        roleRevisionId;
    if (!allowed)
      throw new KonfabError(
        "role_replaced",
        410,
        "Roles were replaced by skills; call read_role or read_assignment for your assignment.",
      );
    const row = this.db
      .prepare(
        `SELECT b.content FROM legacy_role_files f JOIN skill_blobs b ON b.hash = f.blob_hash
         WHERE f.role_revision_id = ? AND f.path = ?`,
      )
      .get(roleRevisionId, path) as { content: Buffer } | undefined;
    if (!row)
      throw new KonfabError("unavailable", 404, "Role file unavailable");
    return fileChunk(row.content, offset, max);
  }
}

export interface LegacyRole {
  id: string;
  revision_id: string;
  name: string;
  number: number;
  changed: boolean;
  reminder?: string;
  title?: string;
  notes?: string;
  role_md?: string;
  skills?: unknown[];
}

export interface TurnSnapshot {
  assignment: FullAssignment;
  legacy_role?: LegacyRole;
}
