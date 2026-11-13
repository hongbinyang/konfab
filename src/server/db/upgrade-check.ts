import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SKILL_UPGRADE_VERSION } from "./index.js";
import { UpgradeStopped } from "./skill-upgrade.js";

/**
 * Runs the role-to-skill upgrade on a temporary copy of the database and
 * describes the result. The live database is only read.
 */
export function checkUpgrade(path: string): { ok: boolean; report: string } {
  if (!existsSync(path)) return { ok: true, report: "No Konfab database yet." };
  const source = new Database(path, { readonly: true, fileMustExist: true });
  const version = source.pragma("user_version", { simple: true }) as number;
  if (version >= SKILL_UPGRADE_VERSION) {
    source.close();
    return {
      ok: true,
      report: "This database already uses skill assignments.",
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "konfab-upgrade-check-"));
  try {
    const copy = join(dir, "konfab.db");
    source.prepare("VACUUM INTO ?").run(copy);
    source.close();
    let db;
    try {
      db = openDatabase(copy);
    } catch (error) {
      if (error instanceof UpgradeStopped)
        return { ok: false, report: error.message };
      throw error;
    }
    try {
      const lines = ["The upgrade would succeed. Each member would receive:"];
      const members = db
        .prepare(
          `SELECT r.name AS room, COALESCE(n.name, a.display_name) AS member, m.room_id, m.agent_id, length(m.instructions) AS chars
           FROM room_members m JOIN rooms r ON r.id = m.room_id JOIN agents a ON a.id = m.agent_id
           LEFT JOIN room_agent_names n ON n.room_id = m.room_id AND n.agent_id = m.agent_id
           ORDER BY r.name, m.position`,
        )
        .all() as Array<{
        room: string;
        member: string;
        room_id: number;
        agent_id: string;
        chars: number;
      }>;
      for (const member of members) {
        const pins = (
          db
            .prepare(
              `SELECT r.name, r.number, p.delivery FROM room_member_skills p JOIN skill_revisions r ON r.id = p.skill_revision_id
               WHERE p.room_id = ? AND p.agent_id = ? ORDER BY p.position`,
            )
            .all(member.room_id, member.agent_id) as Array<{
            name: string;
            number: number;
            delivery: string;
          }>
        ).map((pin) => `${pin.name} rev ${pin.number} (${pin.delivery})`);
        lines.push(
          `- ${member.room} · ${member.member}: ${pins.length ? pins.join(", ") : "no skills"}; room instructions ${member.chars} characters`,
        );
      }
      for (const row of db
        .prepare("SELECT detail FROM upgrade_log ORDER BY id")
        .all() as Array<{ detail: string }>)
        lines.push(`- ${row.detail}`);
      return { ok: true, report: lines.join("\n") };
    } finally {
      db.close();
    }
  } finally {
    if (source.open) source.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
