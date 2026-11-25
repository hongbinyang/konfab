import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";

// Two real processes on one real database file, as in rejoin-races.
const ROOT = resolve(import.meta.dirname, "../..");
const ROUNDS = 30;
const EVERY_MS = 12;
const built = (path: string) =>
  JSON.stringify(pathToFileURL(join(ROOT, "dist/server", path)).href);

const SCRIPT = `
import { openDatabase } from ${built("db/index.js")};
import { KonfabService } from ${built("domain/service.js")};
const job = JSON.parse(process.argv[2]);
const db = openDatabase(job.file);
const service = new KonfabService(db, { waitTimeoutSeconds: 1, turnTimeoutMs: 1e9, maxMessageChars: 1000 });
service.startedAt = 0;
service.rejoin.available = () => true;
const actions = {
  stop: (r) => service.stops.ask(r.room, "codex"),
  keep: (r) => service.stops.keep(r.room, "codex"),
  wait: (r) => { const a = service.poll("codex", r.session, true); return a.status === "closed" ? a.reason : a.status; },
  pass: (r) => { const a = service.passTurn("codex", r.session, r.turn); return a.stopped ? "stopped" : "passed"; },
  post: (r) => { const a = service.postAgentMessage("codex", r.session, r.turn, "Done", { kind: "self" }); return a.stopped ? "stopped" : "posted"; },
  pause: (r) => service.setRoomPaused(r.room, true),
  break: (r) => service.startBreak(r.room),
  archive: (r) => service.archiveRoom(r.room),
  join: (r) => service.join("codex", r.name, r.conversation).session_id,
  rejoin: (r) => service.rejoin.ask(r.room, "codex", true).id,
};
const results = [];
for (const [i, round] of job.rounds.entries()) {
  while (Date.now() < job.start + i * ${EVERY_MS}) {}
  for (;;) {
    try { results.push({ ok: true, value: actions[job.action](round) ?? null }); break; }
    catch (error) {
      if (String(error.code).startsWith("SQLITE_BUSY")) continue;
      results.push({ ok: false, value: error.code ?? error.message }); break;
    }
  }
}
db.close();
console.log(JSON.stringify(results));
`;

type Round = {
  room: number;
  name: string;
  session: string;
  conversation: string;
  turn: number;
};
type Outcome = { ok: boolean; value: string | number | null };

describe("stop races between two processes", () => {
  let root: string;
  let file: string;
  let script: string;
  let db: Db;
  let service: KonfabService;

  /** `inTurn`: its turn runs. Otherwise one is queued. */
  const prepare = (count: number, inTurn: boolean, asked = false): Round[] =>
    Array.from({ length: count }, (_, i) => {
      const name = `race-${i}`;
      const conversation = `019a0000-0000-7000-8000-${String(i).padStart(12, "0")}`;
      service.createRoom(name, "", ["claude", "codex"]);
      const session = service.join("codex", name, conversation).session_id;
      const room = service["room"](name).id;
      service.postUserMessage(name, "@codex work");
      const first = inTurn
        ? service.poll("codex", session, true)
        : { status: "idle" as const };
      if (asked) service.stops.ask(room, "codex");
      return {
        room,
        name,
        session,
        conversation,
        turn: first.status === "turn" ? first.turn_id : 0,
      };
    });
  const run = (action: string, rounds: Round[], start: number) =>
    new Promise<Outcome[]>((done, fail) => {
      const child = spawn(
        process.execPath,
        [script, JSON.stringify({ file, action, rounds, start })],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let errors = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (errors += chunk));
      child.once("close", (code) =>
        code === 0 ? done(JSON.parse(out)) : fail(new Error(errors)),
      );
    });
  const race = async (rounds: Round[], first: string, second: string) => {
    const start = Date.now() + 1500;
    const [a, b] = await Promise.all([
      run(first, rounds, start),
      run(second, rounds, start),
    ]);
    return rounds.map((round, i) => ({
      round,
      first: a[i]!,
      second: b[i]!,
      ...state(round),
    }));
  };
  const state = (round: Round) => ({
    turns: (
      db
        .prepare(
          "SELECT agent_id, state FROM turns WHERE room_id = ? ORDER BY id",
        )
        .all(round.room) as { agent_id: string; state: string }[]
    ).map((turn) => turn.state),
    session: db
      .prepare(
        "SELECT state, end_reason, stop_asked_at AS asked FROM sessions WHERE id = ?",
      )
      .get(round.session) as {
      state: string;
      end_reason: string | null;
      asked: number | null;
    },
    active: db
      .prepare("SELECT 1 FROM sessions WHERE room_id = ? AND state = 'active'")
      .all(round.room).length,
    saved: (
      db
        .prepare(
          "SELECT saved_run_ms AS ms FROM room_members WHERE room_id = ? AND agent_id = 'codex'",
        )
        .get(round.room) as { ms: number | null }
    ).ms,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "konfab-stop-races-"));
    file = join(root, "konfab.db");
    script = join(root, "race.mjs");
    writeFileSync(script, SCRIPT);
    db = openDatabase(file);
    service = new KonfabService(db, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 1e9,
      maxMessageChars: 1000,
    });
    Object.assign(service, { startedAt: 0 });
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("stop or the start of a turn: the turn is there once, and never in an ended session", async () => {
    for (const { first, second, turns, session } of await race(
      prepare(ROUNDS, false),
      "stop",
      "wait",
    )) {
      expect(first.ok).toBe(true);
      expect(turns).toHaveLength(1);
      if (second.value === "turn") {
        expect(turns).toEqual(["active"]);
        expect(session).toMatchObject({ state: "active" });
        expect(session.asked).not.toBeNull();
      } else {
        expect(turns).toEqual(["queued"]);
        expect(session).toMatchObject({
          state: "ended",
          end_reason: "stopped",
        });
        expect(second.value).toBe("stopped");
      }
    }
  }, 30_000);

  it.each(["pass", "post"])(
    "stop or the end of a turn by %s: it ends once, and its answer fits",
    async (how) => {
      for (const { first, second, turns, session, saved } of await race(
        prepare(ROUNDS, true),
        "stop",
        how,
      )) {
        expect(first.ok && second.ok).toBe(true);
        expect(session).toMatchObject({
          state: "ended",
          end_reason: "stopped",
        });
        expect(saved).not.toBeNull();
        expect(turns).toEqual(
          how === "post" ? ["completed", "queued"] : ["completed"],
        );
      }
    },
    30_000,
  );

  it("Keep in room or the end of a turn: kept, or too late", async () => {
    for (const { first, second, session, saved } of await race(
      prepare(ROUNDS, true, true),
      "keep",
      "pass",
    )) {
      expect(second.ok).toBe(true);
      if (first.ok) {
        expect(second.value).toBe("passed");
        expect(session).toEqual({
          state: "active",
          end_reason: null,
          asked: null,
        });
        expect(saved).toBeNull();
      } else {
        expect(first.value).toBe("stop_done");
        expect(second.value).toBe("stopped");
        expect(session.end_reason).toBe("stopped");
      }
    }
  }, 30_000);

  it.each(["pause", "break", "archive"])(
    "stop or %s: one end, with one reason, and the room as it was set",
    async (other) => {
      for (const { round, session, saved, turns } of await race(
        prepare(ROUNDS, false),
        "stop",
        other,
      )) {
        const room = db
          .prepare(
            "SELECT paused, on_break, archived_at FROM rooms WHERE id = ?",
          )
          .get(round.room) as {
          paused: number;
          on_break: number;
          archived_at: number | null;
        };
        if (other === "pause") {
          expect(room.paused).toBe(1);
          expect(session.end_reason).toBe("stopped");
        } else {
          expect(session.state).toBe("ended");
          expect([
            "stopped",
            other === "break" ? "on_break" : "room_archived",
          ]).toContain(session.end_reason);
        }
        if (other !== "archive") expect(saved).not.toBeNull();
        // Archiving drops what is queued, as always.
        expect(turns).toEqual([other === "archive" ? "dropped" : "queued"]);
      }
    },
    30_000,
  );

  it("stop or an ordinary join: one active session at most, and its turn once", async () => {
    for (const { first, second, turns, session, active } of await race(
      prepare(ROUNDS, true),
      "stop",
      "join",
    )) {
      expect(second.ok).toBe(true);
      expect(session.state).toBe("replaced");
      expect(first.ok).toBe(true);
      // After the join, the click stopped the new session.
      expect(active).toBeLessThanOrEqual(1);
      expect(turns.filter((turn) => turn === "queued")).toHaveLength(1);
      expect(turns.filter((turn) => turn === "active")).toHaveLength(0);
    }
  }, 30_000);

  it("stop twice at once is one stop", async () => {
    for (const { round, first, second, session } of await race(
      prepare(ROUNDS, true),
      "stop",
      "stop",
    )) {
      expect(first.ok && second.ok).toBe(true);
      expect(session.asked).not.toBeNull();
      expect(
        db
          .prepare(
            "SELECT 1 FROM events WHERE room_id = ? AND type = 'stop_asked'",
          )
          .all(round.room),
      ).toHaveLength(1);
    }
  }, 30_000);

  it("never asks for a rejoin of one that is asked to stop", async () => {
    const rounds = prepare(ROUNDS, true, true);
    db.prepare("UPDATE sessions SET last_call_at = 1").run();
    for (const { first, second, session } of await race(
      rounds,
      "rejoin",
      "keep",
    )) {
      expect(second.ok).toBe(true);
      expect(first).toEqual({ ok: false, value: "rejoin_unavailable" });
      expect(session.state).toBe("active");
    }
  }, 30_000);
});
