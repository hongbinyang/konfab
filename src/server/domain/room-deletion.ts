import { lstatSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Db } from "../db/index.js";

export type DeletionCounts = {
  messages: number;
  decisions: number;
  attachments: number;
  attachment_bytes: number;
};

export function roomDeletionCounts(db: Db, id: number): DeletionCounts {
  const count = (table: string) =>
    (
      db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE room_id=?`)
        .get(id) as { n: number }
    ).n;
  const bytes = db
    .prepare(
      "SELECT COALESCE(SUM(size),0) AS n FROM attachments WHERE room_id=?",
    )
    .get(id) as { n: number };
  return {
    messages: count("messages"),
    decisions: count("decisions"),
    attachments: count("attachments"),
    attachment_bytes: bytes.n,
  };
}

/** Only explicit database tombstones are eligible for file cleanup. */
export function cleanupRoomFiles(
  db: Db,
  root: string | undefined,
  id: number,
): boolean {
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  if (
    !db.prepare("SELECT 1 FROM pending_room_cleanup WHERE room_id=?").get(id) ||
    db.prepare("SELECT 1 FROM rooms WHERE id=?").get(id)
  )
    return false;
  if (!root) return false;
  try {
    let base;
    try {
      base = lstatSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        db.prepare("DELETE FROM pending_room_cleanup WHERE room_id=?").run(id);
        return true;
      }
      throw error;
    }
    if (base.isSymbolicLink() || !base.isDirectory()) return false;
    const directory = join(resolve(root), String(id));
    let stat;
    try {
      stat = lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        db.prepare("DELETE FROM pending_room_cleanup WHERE room_id=?").run(id);
        return true;
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    rmSync(directory, { recursive: true, force: true });
    db.prepare("DELETE FROM pending_room_cleanup WHERE room_id=?").run(id);
    return true;
  } catch {
    return false;
  }
}

export function compactRoomDatabase(db: Db): boolean {
  try {
    db.exec("VACUUM");
    db.prepare(
      "DELETE FROM settings WHERE key='room_delete_vacuum_pending'",
    ).run();
    return true;
  } catch {
    console.warn(
      "Room deletion compaction is pending; it will be retried at startup.",
    );
    return false;
  }
}

export function recoverRoomCleanup(db: Db, root: string | undefined): void {
  const pending = db
    .prepare("SELECT room_id FROM pending_room_cleanup")
    .all() as { room_id: number }[];
  for (const row of pending) cleanupRoomFiles(db, root, row.room_id);
  if (
    db
      .prepare("SELECT 1 FROM settings WHERE key='room_delete_vacuum_pending'")
      .get()
  )
    compactRoomDatabase(db);
}

export function deleteRoomRows(
  db: Db,
  id: number,
  name: string,
  counts: DeletionCounts,
  now: number,
): void {
  db.transaction(() => {
    db.prepare(
      `DELETE FROM bridge_receipts WHERE (json_extract(payload, '$.path')='/agent/join' AND json_extract(payload, '$.body.room')=?) OR json_extract(payload, '$.body.session_id') IN (SELECT id FROM sessions WHERE room_id=?) OR json_extract(result, '$.session_id') IN (SELECT id FROM sessions WHERE room_id=?)`,
    ).run(name, id, id);
    db.prepare(
      "DELETE FROM handoffs WHERE source_message_id IN (SELECT id FROM messages WHERE room_id=?) OR turn_id IN (SELECT id FROM turns WHERE room_id=?)",
    ).run(id, id);
    db.prepare(
      "DELETE FROM skill_usages WHERE (owner_type='assignment' AND owner_id LIKE ? || ':%') OR (owner_type='turn' AND owner_id IN (SELECT CAST(id AS TEXT) FROM turns WHERE room_id=?))",
    ).run(String(id), id);
    db.prepare(
      "DELETE FROM decision_versions WHERE decision_id IN (SELECT id FROM decisions WHERE room_id=?)",
    ).run(id);
    for (const table of ["observed_waits", "run_warning_state", "run_warnings"])
      db.prepare(
        `DELETE FROM ${table} WHERE session_id IN (SELECT id FROM sessions WHERE room_id=?)`,
      ).run(id);
    for (const table of [
      "automatic_continuations",
      "lead_seen_messages",
      "attachments",
      "decisions",
      "write_locks",
      "room_member_skills",
      "room_agent_names",
      "agent_reports",
      "permission_requests",
      "events",
      "turns",
      "format_runs",
      "sessions",
      "messages",
      "room_members",
    ])
      db.prepare(`DELETE FROM ${table} WHERE room_id=?`).run(id);
    db.prepare("DELETE FROM rooms WHERE id=?").run(id);
    db.prepare(
      "INSERT INTO pending_room_cleanup(room_id,created_at) VALUES (?,?)",
    ).run(id, now);
    db.prepare(
      "INSERT INTO settings(key,value) VALUES ('room_delete_vacuum_pending','1') ON CONFLICT(key) DO UPDATE SET value='1'",
    ).run();
    db.prepare(
      "INSERT INTO events(type,room_id,agent_id,payload,created_at) VALUES ('room_deleted',NULL,NULL,?,?)",
    ).run(JSON.stringify({ room: name, counts }), now);
  })();
}
