import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";

// Two real processes on one real database file. Only one runs in normal use;
// this shows that the order is decided by the database and nothing else.
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
const now = () => Date.now() + (job.later ?? 0);
const service = new KonfabService(db, { now, waitTimeoutSeconds: 1, turnTimeoutMs: 1e9, maxMessageChars: 1000 });
service.rejoin.available = () => true;
// Right after a start, agents are given time to call again.
service.startedAt = 0;
const actions = {
  rejoin: (r) => service.rejoin.rejoin("codex", r.number, r.conversation).session_id ?? null,
  cancel: (r) => service.rejoin.cancel(r.room, "codex"),
  expire: () => service.rejoin.closeStale(),
  pause: (r) => service.setRoomPaused(r.room, true),
  break: (r) => service.startBreak(r.room),
  archive: (r) => service.archiveRoom(r.room),
  remove: (r) => service.setMembers(r.room, ["claude"]),
  join: (r) => service.join("codex", r.name, r.conversation).session_id,
};
const results = [];
for (const [i, round] of job.rounds.entries()) {
  while (Date.now() < job.start + i * ${EVERY_MS}) {}
  for (;;) {
    try {
      results.push({ ok: true, value: actions[job.action](round) ?? null });
      break;
    } catch (error) {
      // Two processes don't normally share it; a plain transaction may be told to retry.
      if (String(error.code).startsWith("SQLITE_BUSY")) continue;
      results.push({ ok: false, value: error.message });
      break;
    }
  }
}
db.close();
console.log(JSON.stringify(results));
`;

type Round = {
  room: number;
  name: string;
  number: string;
  conversation: string;
};
type Outcome = { ok: boolean; value: string | null };
type Request = {
  state: string;
  reason: string | null;
  joined_session_id: string | null;
};

describe("rejoin races between two processes", () => {
  let root: string;
  let file: string;
  let script: string;
  let db: Db;
  let service: KonfabService;

  const prepare = (count: number): Round[] =>
    Array.from({ length: count }, (_, i) => {
      const name = `race-${i}`;
      const conversation = `019a0000-0000-7000-8000-${String(i).padStart(12, "0")}`;
      service.createRoom(name, "", ["claude", "codex"]);
      const session = service.join("codex", name, conversation).session_id;
      db.prepare("UPDATE sessions SET last_call_at = 1 WHERE id = ?").run(
        session,
      );
      const room = service["room"](name).id;
      const asked = service.rejoin.ask(room, "codex", false);
      service.rejoin.sent(asked.id, "taken");
      return { room, name, number: asked.number, conversation };
    });
  const run = (action: string, rounds: Round[], start: number, later = 0) =>
    new Promise<Outcome[]>((done, fail) => {
      const child = spawn(
        process.execPath,
        [script, JSON.stringify({ file, action, rounds, start, later })],
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
  const race = async (first: string, second: string, later = 0) => {
    const rounds = prepare(ROUNDS);
    const start = Date.now() + 1500;
    const [a, b] = await Promise.all([
      run(first, rounds, start),
      run(second, rounds, start, later),
    ]);
    return rounds.map((round, i) => ({
      round,
      first: a[i]!,
      second: b[i]!,
      request: db
        .prepare(
          "SELECT state, reason, joined_session_id FROM rejoin_requests WHERE room_id = ?",
        )
        .get(round.room) as Request,
      sessions: db
        .prepare(
          "SELECT id, state FROM sessions WHERE room_id = ? ORDER BY rowid",
        )
        .all(round.room) as { id: string; state: string }[],
      room: db
        .prepare("SELECT paused, on_break, archived_at FROM rooms WHERE id = ?")
        .get(round.room) as {
        paused: number;
        on_break: number;
        archived_at: number | null;
      },
    }));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "konfab-races-"));
    file = join(root, "konfab.db");
    script = join(root, "race.mjs");
    writeFileSync(script, SCRIPT);
    db = openDatabase(file);
    service = new KonfabService(db, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 1e9,
      maxMessageChars: 1000,
    });
    service.rejoin.available = () => true;
    Object.assign(service, { startedAt: 0 });
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["cancel", "cancelled"],
    ["expire", "expired"],
    ["pause", "changed"],
    ["break", "changed"],
    ["archive", "changed"],
    ["remove", "changed"],
    ["join", "replaced"],
  ])(
    "either rejoins or is closed, never half: %s",
    async (other, reason) => {
      const rounds = await race(
        "rejoin",
        other,
        other === "expire" ? 11 * 60_000 : 0,
      );
      const won = { rejoin: 0, other: 0 };
      for (const { first, second, request, sessions, room } of rounds) {
        expect(first.ok).toBe(true);
        const extra = other === "join" ? 1 : 0;
        if (first.value) {
          won.rejoin += 1;
          expect(request.joined_session_id).toBe(first.value);
          expect(sessions).toHaveLength(2 + extra);
        } else {
          won.other += 1;
          expect(request).toMatchObject({
            state: "closed",
            reason,
            joined_session_id: null,
          });
          expect(sessions).toHaveLength(1 + extra);
        }
        expect(
          sessions.filter((s) => s.state === "active").length,
        ).toBeLessThanOrEqual(1);
        // Whatever the order, the lead's change stays.
        if (other === "pause") expect(room.paused).toBe(1);
        if (other === "break") expect(room.on_break).toBe(1);
        if (other === "archive") expect(room.archived_at).not.toBeNull();
        if (other === "cancel") expect(second.ok).toBe(first.value === null);
        if (other === "join")
          expect(request).toMatchObject({
            state: "closed",
            reason: "replaced",
          });
        expect(request.state).not.toBe("back");
      }
      expect(won.rejoin + won.other).toBe(ROUNDS);
    },
    30_000,
  );

  it("answers the same call made twice at once with one session", async () => {
    for (const { first, second, sessions } of await race("rejoin", "rejoin")) {
      expect(first.value).not.toBeNull();
      expect(second.value).toBe(first.value);
      expect(sessions).toHaveLength(2);
    }
  }, 30_000);

  it.each([
    ["before", "rejoin"],
    ["before", "cancel"],
    ["before", "expire"],
    ["before", "pause"],
    ["before", "join"],
    ["after", "cancel"],
    ["after", "expire"],
    ["after", "pause"],
    ["after", "break"],
    ["after", "archive"],
    ["after", "remove"],
    ["after", "join"],
  ])(
    "gives the stated outcome in a fixed order: rejoin %s %s",
    async (order, other) => {
      const rounds = prepare(3);
      const later = other === "expire" ? 11 * 60_000 : 0;
      const steps = order === "before" ? ["rejoin", other] : [other, "rejoin"];
      const results: Record<string, Outcome[]> = {};
      for (const step of steps)
        results[step] = await run(step, rounds, 0, step === other ? later : 0);
      for (const [i, round] of rounds.entries()) {
        const request = db
          .prepare(
            "SELECT state, reason, joined_session_id FROM rejoin_requests WHERE room_id = ?",
          )
          .get(round.room) as Request;
        const joined = results.rejoin![i]!.value;
        if (order === "after") {
          expect(joined).toBeNull();
          expect(request.state).toBe("closed");
        } else {
          expect(joined).not.toBeNull();
          expect(request.state).toBe(other === "join" ? "closed" : "joined");
          if (other === "cancel")
            expect(results.cancel![i]).toMatchObject({ ok: false });
        }
      }
    },
    30_000,
  );

  it.each([
    ["while the session is being made", "startSession", "waiting", 1],
    ["while the answer is being made", "reply", "waiting", 1],
    ["after it is stored, before the answer", "notify", "joined", 2],
  ] as const)(
    "survives being killed %s",
    async (_name, at, state, sessions) => {
      const [round] = prepare(1);
      const killer = join(root, "kill.mjs");
      writeFileSync(
        killer,
        SCRIPT.replace(
          "service.rejoin.available =",
          `const real = service.rejoin.deps.${at};
           service.rejoin.deps.${at} = (...a) => { const r = real(...a); process.kill(process.pid, "SIGKILL"); return r; };
           service.rejoin.available =`,
        ),
      );
      const child = spawn(process.execPath, [
        killer,
        JSON.stringify({ file, action: "rejoin", rounds: [round], start: 0 }),
      ]);
      const signal = await new Promise((done) =>
        child.once("exit", (_code, name) => done(name)),
      );
      expect(signal).toBe("SIGKILL");
      const stored = () =>
        db
          .prepare("SELECT state FROM rejoin_requests")
          .all()
          .map((row) => (row as { state: string }).state);
      const count = () => db.prepare("SELECT 1 FROM sessions").all().length;
      expect(stored()).toEqual([state]);
      expect(count()).toBe(sessions);
      // Konfab starts again, and the connector repeats the call.
      service.recoverAfterRestart();
      const again = await run("rejoin", [round!], 0);
      expect(again[0]!.value).not.toBeNull();
      expect(stored()).toEqual(["joined"]);
      expect(count()).toBe(2);
    },
    30_000,
  );
});
