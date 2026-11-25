import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";
import { STOP_INSTRUCTIONS, STOP_LATER } from "../../src/server/domain/stop.js";

const ROOM = "stop";
const HOUR = 3_600_000;
const CODEX = "019a0000-0000-7000-8000-000000000001";

describe("stopping one agent", () => {
  let db: Db;
  let now: number;
  let service: KonfabService;
  let roomId: number;
  let claude: string;
  let codex: string;
  let calls: number;

  const create = () => {
    const made = new KonfabService(db, {
      now: () => now,
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 30 * 60_000,
      maxMessageChars: 1000,
      runHoursFor: () => 5,
    });
    Object.assign(made, { startedAt: 0 });
    made.rejoin.available = () => true;
    return made;
  };
  const session = (id: string) =>
    db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as {
      state: string;
      end_reason: string | null;
      stop_asked_at: number | null;
      stop_answered_at: number | null;
      stop_received_at: number | null;
      stop_called_at: number | null;
    };
  const agent = (id = "codex") =>
    service.roomState(ROOM).agents.find((item) => item.id === id)!;
  const view = (id = "codex") => service.stops.view(roomId, id);
  const offer = (id = "codex") => service.rejoin.view(roomId, id).offer;
  const ask = (id = "codex") => service.stops.ask(roomId, id);
  const keep = (id = "codex") => service.stops.keep(roomId, id);
  /** A wait as the API makes it; `lost` is an answer that doesn't arrive. */
  const wait = (
    id: string,
    sessionId: string,
    lost = false,
    again?: string,
  ) => {
    const call = again ?? `call-${(calls += 1)}`;
    service.beginObservedWait(id, sessionId, call);
    const result = service.poll(id, sessionId, true);
    if (result.status === "closed" && result.reason === "stopped")
      service.stops.answeredWait(sessionId, call);
    // The connector ends an idle one as well.
    if (!lost) service.finishObservedWait(id, sessionId, call);
    return { result, call };
  };
  const turn = (id: string, sessionId: string) => {
    const { result } = wait(id, sessionId);
    if (result.status !== "turn") throw new Error(result.status);
    return result.turn_id;
  };
  const queue = () =>
    (
      db
        .prepare(
          "SELECT id, agent_id, state FROM turns WHERE state IN ('queued','active') ORDER BY id",
        )
        .all() as { id: number; agent_id: string; state: string }[]
    ).map((item) => `${item.agent_id}:${item.state}`);
  const events = () =>
    service
      .activity(ROOM)
      .map((event) => event.type)
      .filter((type) => /stop/.test(type))
      .reverse();
  const saved = () =>
    (
      db
        .prepare(
          "SELECT saved_run_ms AS ms FROM room_members WHERE agent_id = 'codex' AND room_id = ?",
        )
        .get(roomId) as { ms: number | null }
    ).ms;
  const left = (id: string) =>
    service["remainingRunMs"](service["requireSession"]("codex", id));

  beforeEach(() => {
    now = 1_800_000_000_000;
    calls = 0;
    db = openDatabase(":memory:");
    service = create();
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    service.createRoom(ROOM, "", ["claude", "codex"]);
    roomId = service["room"](ROOM).id;
    claude = service.join("claude", ROOM).session_id;
    codex = service.join("codex", ROOM, CODEX).session_id;
    wait("claude", claude);
    wait("codex", codex);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("tells a waiting agent at its next call, and Stopped only when its connector has it", () => {
    expect(view()).toMatchObject({ can: "now", state: null });
    ask();
    expect(session(codex)).toMatchObject({
      state: "ended",
      end_reason: "stopped",
    });
    expect(agent().state).toBe("stopped");
    expect(view()).toMatchObject({ can: null, state: "undelivered" });
    expect(offer()).toBe("connected");
    const { result, call } = wait("codex", codex, true);
    expect(result).toMatchObject({
      status: "closed",
      reason: "stopped",
      instructions: STOP_INSTRUCTIONS,
    });
    expect(view().state).toBe("answered");
    expect(offer()).toBe("connected");
    service.finishObservedWait("codex", codex, call);
    expect(view()).toMatchObject({ state: "received", called_at: null });
    expect(offer()).toBe("ready");
    expect(events()).toEqual(["stop_asked", "stopped"]);
    // Nobody else is affected.
    expect(agent("claude").state).toBe("waiting");
  });

  it("answers a held wait at once", async () => {
    vi.useRealTimers();
    const held = service.waitForTurn("codex", codex, true, 1000);
    const from = Date.now();
    ask();
    expect(await held).toMatchObject({ status: "closed", reason: "stopped" });
    expect(Date.now() - from).toBeLessThan(500);
  });

  it.each([
    ["post", "message_id"],
    ["pass", "ok"],
  ])(
    "lets a running turn finish, then stops with the %s itself",
    (how, field) => {
      service.postUserMessage(ROOM, "@codex work");
      const id = turn("codex", codex);
      expect(view().can).toBe("after_turn");
      ask();
      ask();
      expect(view()).toMatchObject({
        can: null,
        state: "asked",
        after: "turn",
      });
      expect(session(codex).state).toBe("active");
      expect(
        service.reportStatus("codex", codex, "working", "Testing"),
      ).toEqual({
        ok: true,
        stop_requested: STOP_LATER,
      });
      expect(service.poll("codex", codex, true)).toMatchObject({
        status: "turn",
        turn_id: id,
        stop_requested: STOP_LATER,
      });
      const finish = () =>
        how === "post"
          ? service.postAgentMessage("codex", codex, id, "Done", {
              kind: "self",
            })
          : service.passTurn("codex", codex, id);
      const answer = finish();
      expect(answer).toMatchObject({
        stopped: true,
        instructions: STOP_INSTRUCTIONS,
      });
      expect(answer).toHaveProperty(field);
      expect(view().state).toBe("answered");
      // A lost answer, repeated: the same, nothing twice, and not another call.
      expect(finish()).toEqual(answer);
      expect(view().called_at).toBeNull();
      expect(
        db.prepare("SELECT 1 FROM messages WHERE sender_id = 'codex'").all(),
      ).toHaveLength(how === "post" ? 1 : 0);
      // Its own "self" waits for it.
      expect(queue()).toEqual(how === "post" ? ["codex:queued"] : []);
      service.stops.received(codex);
      expect(view().state).toBe("received");
      expect(events()).toEqual(["stop_asked", "stopped"]);
    },
  );

  it("adds stop to a repeated post when it was stopped in between", () => {
    service.postUserMessage(ROOM, "@codex work");
    const id = turn("codex", codex);
    const first = service.postAgentMessage("codex", codex, id, "Done", {
      kind: "lead",
    });
    expect(first).not.toHaveProperty("stopped");
    ask();
    expect(
      service.postAgentMessage("codex", codex, id, "Done", { kind: "lead" }),
    ).toMatchObject({ ...first, stopped: true });
    expect(view()).toMatchObject({ state: "answered", called_at: null });
  });

  it("waits for reported work until its next wait, with its locks", () => {
    service.reportStatus("codex", codex, "working", "Building");
    service.acquireLock("codex", codex, "/tmp/x", "build");
    now += 31_000;
    expect(view()).toMatchObject({ can: "after_work", holds_lock: true });
    ask();
    expect(view()).toMatchObject({ state: "asked", after: "work" });
    // Nothing heard, and a report that has gone stale, change nothing.
    for (let i = 0; i < 20; i += 1) {
      now += 2 * 60_000;
      service.tick();
    }
    expect(session(codex).state).toBe("active");
    expect(view().quiet_since).not.toBeNull();
    expect(offer()).toBe("connected");
    expect(wait("codex", codex).result).toMatchObject({
      status: "closed",
      reason: "stopped",
    });
    expect(db.prepare("SELECT 1 FROM write_locks").all()).toEqual([]);
    expect(view().state).toBe("received");
  });

  it("stops one that waits although it reported work before", () => {
    service.reportStatus("codex", codex, "working", "Building");
    const call = "held";
    service.beginObservedWait("codex", codex, call);
    service.poll("codex", codex, true);
    expect(view().can).toBe("now");
    ask();
    expect(session(codex).state).toBe("ended");
  });

  it("is undone until it has stopped", () => {
    expect(() => keep()).toThrow(/no stop was asked/);
    service.postUserMessage(ROOM, "@codex work");
    const id = turn("codex", codex);
    ask();
    keep();
    expect(view()).toMatchObject({ can: "after_turn", state: null });
    expect(() => keep()).toThrow();
    expect(service.passTurn("codex", codex, id)).toEqual({ ok: true });
    expect(session(codex).state).toBe("active");
    ask();
    expect(() => keep()).toThrow(/use Rejoin/);
    expect(events()).toEqual([
      "stop_asked",
      "stop_undone",
      "stop_asked",
      "stopped",
    ]);
    expect(saved()).not.toBeNull();
  });

  it.each([
    ["away", () => void ((now += 90_001), service.tick())],
    ["on a break", () => service["startBreak"](roomId)],
    ["its window over", () => void (now += 6 * HOUR)],
    ["removed", () => service.setMembers(roomId, ["claude"])],
    ["archived", () => service.archiveRoom(roomId)],
  ] as [string, () => void][])(
    "isn't offered when it is %s",
    (_name, change) => {
      change();
      expect(view().can).toBeNull();
      expect(() => ask()).toThrow(/isn't there/);
    },
  );

  it("isn't offered for one leaving for a break, in a turn", () => {
    service.postUserMessage(ROOM, "@codex work");
    turn("codex", codex);
    service["startBreak"](roomId);
    expect(view().can).toBeNull();
    expect(() => ask()).toThrow(/isn't there/);
  });

  it("works in a paused room, and leaves the pause alone", () => {
    service.setRoomPaused(roomId, true);
    ask();
    expect(wait("codex", codex).result).toMatchObject({ reason: "stopped" });
    expect(service["room"](ROOM).paused).toBe(1);
  });

  it("ends once with the break's reason when a break comes first", () => {
    service.postUserMessage(ROOM, "@codex work");
    const id = turn("codex", codex);
    ask();
    service["startBreak"](roomId);
    expect(service.passTurn("codex", codex, id)).toEqual({ ok: true });
    expect(session(codex)).toMatchObject({
      state: "ended",
      end_reason: "on_break",
    });
    expect(wait("codex", codex).result).toMatchObject({ reason: "on_break" });
  });

  describe("later calls", () => {
    const stopped = () => {
      ask();
      wait("codex", codex);
      now += 1000;
    };

    it("are refused, change nothing and are no contact", () => {
      stopped();
      const before = (
        db
          .prepare("SELECT last_call_at AS at FROM sessions WHERE id = ?")
          .get(codex) as {
          at: number;
        }
      ).at;
      for (const [i, act] of [
        () => service.reportStatus("codex", codex, "working", "More"),
        () => service.acquireLock("codex", codex, "/tmp/x", "y"),
        () => service.getPermission("codex", codex, 1),
      ].entries()) {
        expect(act).toThrow(STOP_INSTRUCTIONS);
        service.stops.refusedCall(codex, `key-${i}`);
      }
      expect(view().called_at).toBe(now);
      expect(
        db
          .prepare("SELECT last_call_at AS at FROM sessions WHERE id = ?")
          .get(codex),
      ).toEqual({ at: before });
      expect(events()).toEqual(["stop_asked", "stopped", "called_after_stop"]);
    });

    it("aren't counted for a repeat of the same wait or request", () => {
      ask();
      const { call } = wait("codex", codex, true);
      now += 1000;
      wait("codex", codex, true, call);
      wait("codex", codex, false, call);
      expect(view()).toMatchObject({ state: "received", called_at: null });
      service.stops.refusedCall(codex, "same");
      expect(view().called_at).toBe(now);
      now += 1000;
      service.stops.refusedCall(codex, "same");
      expect(view().called_at).toBe(now - 1000);
    });

    it("count when it waits again after it was told", () => {
      stopped();
      wait("codex", codex);
      expect(view()).toMatchObject({ state: "received", called_at: now });
      expect(offer()).toBe("connected");
      now += 90_000;
      expect(offer()).toBe("ready");
    });

    it("tell one whose session ended while no call was open, by a refusal", () => {
      ask();
      expect(view().state).toBe("undelivered");
      expect(() =>
        service.reportStatus("codex", codex, "working", "More"),
      ).toThrow(STOP_INSTRUCTIONS);
      service.stops.refusedCall(codex, undefined);
      expect(view()).toMatchObject({ state: "answered", called_at: null });
    });
  });

  describe("what can be confirmed", () => {
    it.each([
      ["never delivered", () => {}],
      ["answered, not confirmed", () => void wait("codex", codex, true)],
    ] as [string, () => void][])(
      "%s: not Stopped, and Rejoin only after 90 seconds",
      (_n, act) => {
        ask();
        act();
        now += 89_999;
        expect(["undelivered", "answered"]).toContain(view().state);
        expect(offer()).toBe("connected");
        now += 1;
        expect(view()).toMatchObject({ long_ago: true, called_at: null });
        expect(offer()).toBe("ready");
      },
    );

    it("is only made by the connector's word for that very call", () => {
      ask();
      wait("codex", codex, true);
      service.finishObservedWait("codex", codex, "another");
      expect(view().state).toBe("answered");
    });

    it("is never made before there was an answer, or for a session that isn't stopped", () => {
      service.stops.received(codex);
      ask();
      service.stops.received(codex);
      expect(view().state).toBe("undelivered");
      service.stops.received(claude);
      expect(session(claude).stop_received_at).toBeNull();
      wait("codex", codex, true);
      service.stops.received(codex);
      expect(view().state).toBe("received");
    });

    it("an earlier wait's end says nothing", () => {
      const held = "before";
      service.beginObservedWait("codex", codex, held);
      service.poll("codex", codex, true);
      service.postUserMessage(ROOM, "@codex work");
      const id = turn("codex", codex);
      ask();
      service.passTurn("codex", codex, id);
      service.finishObservedWait("codex", codex, held);
      expect(view().state).toBe("answered");
    });
  });

  describe("Rejoin", () => {
    it("is refused while a stop is asked, however long nothing is heard, and changes nothing", () => {
      service.postUserMessage(ROOM, "@codex work");
      turn("codex", codex);
      service.acquireLock("codex", codex, "/tmp/x", "y", 240);
      ask();
      const snapshot = () =>
        JSON.stringify(
          ["sessions", "turns", "write_locks", "rejoin_requests"].map((table) =>
            db.prepare(`SELECT * FROM ${table}`).all(),
          ),
        );
      for (const later of [0, 91_000, 10 * 60_000]) {
        now += later;
        const before = snapshot();
        expect(offer()).not.toBe("ready");
        expect(() => service.rejoin.ask(roomId, "codex", true)).toThrow(
          /can't be asked/,
        );
        expect(snapshot()).toBe(before);
      }
      service = create();
      service.recoverAfterRestart();
      expect(() => service.rejoin.ask(roomId, "codex", true)).toThrow();
    });

    it("works after Keep in room when contact is lost, and replaces as today", () => {
      service.reportStatus("codex", codex, "working", "Building");
      service.acquireLock("codex", codex, "/tmp/x", "y", 240);
      now += 31_000;
      ask();
      now += 20 * 60_000;
      service.tick();
      expect(offer()).not.toBe("ready");
      keep();
      expect(offer()).toBe("ready");
      const { number } = service.rejoin.ask(roomId, "codex", false);
      const joined = service.rejoin.rejoin("codex", number, CODEX) as {
        session_id: string;
      };
      expect(joined.session_id).toBeTruthy();
      expect(session(codex).state).toBe("replaced");
      expect(db.prepare("SELECT 1 FROM write_locks").all()).toEqual([]);
      for (const late of [
        () => service.reportStatus("codex", codex, "working", "x"),
        () => service.acquireLock("codex", codex, "/tmp/x", "y"),
      ])
        expect(late).toThrow(/newer conversation/);
      expect(db.prepare("SELECT 1 FROM write_locks").all()).toEqual([]);
    });

    it("brings a stopped agent back to its own queued work, with one session", () => {
      ask();
      wait("codex", codex);
      service.postUserMessage(ROOM, "@codex first");
      service.postUserMessage(ROOM, "@codex second");
      expect(queue()).toEqual(["codex:queued"]);
      now += 1000;
      const { number } = service.rejoin.ask(roomId, "codex", false);
      const joined = service.rejoin.rejoin("codex", number, CODEX) as {
        session_id: string;
      };
      expect(wait("codex", joined.session_id).result.status).toBe("turn");
      expect(service.roomState(ROOM).returns).toHaveLength(1);
      // A late call of the old session doesn't close anything.
      wait("codex", codex);
      expect(view()).toMatchObject({ state: null, can: "after_turn" });
      expect(
        db.prepare("SELECT 1 FROM sessions WHERE agent_id = 'codex'").all(),
      ).toHaveLength(2);
    });

    it("can be asked again when it is stopped before its first wait", () => {
      ask();
      wait("codex", codex);
      now += 1000;
      const { number } = service.rejoin.ask(roomId, "codex", false);
      service.rejoin.rejoin("codex", number, CODEX);
      ask();
      now += 90_000;
      expect(offer()).toBe("ready");
      service.rejoin.ask(roomId, "codex", true);
    });
  });

  describe("an ordinary join", () => {
    it("ends what was asked, and says so without saying who wanted it", () => {
      service.postUserMessage(ROOM, "@codex work");
      turn("codex", codex);
      ask();
      now += 1000;
      codex = service.join("codex", ROOM, CODEX).session_id;
      expect(view()).toMatchObject({
        state: null,
        can: "now",
        joined_again_at: now,
      });
      // Its turn is queued again, once.
      expect(queue()).toEqual(["codex:queued"]);
      expect(events()).toContain("joined_again_stop_void");
      expect(service.roomState(ROOM).stops.map((item) => item.kind)).toEqual([
        "void",
      ]);
      now += 10 * 60_000;
      expect(view().joined_again_at).toBeNull();
    });

    it("after a stop is marked, and the room says that it is back", () => {
      ask();
      wait("codex", codex);
      const joined = service.join("codex", ROOM).session_id;
      wait("codex", joined);
      expect(events().at(-1)).toBe("joined_after_stop");
      expect(service.roomState(ROOM).returns).toHaveLength(1);
      expect(view()).toMatchObject({ state: null, joined_again_at: null });
    });
  });

  describe("the queue", () => {
    it("isn't held by a stopped or stopping agent, and loses nothing", () => {
      service.reportStatus("codex", codex, "working", "Building");
      now += 31_000;
      wait("claude", claude);
      service.postUserMessage(ROOM, "@codex first");
      service.postUserMessage(ROOM, "@claude second");
      expect(queue()).toEqual(["codex:queued", "claude:queued"]);
      ask();
      expect(service.roomState(ROOM).routing.eligible_agents).toEqual([
        "claude",
      ]);
      // Codex is first, and is passed over.
      const id = turn("claude", claude);
      expect(queue()).toEqual(["codex:queued", "claude:active"]);
      keep();
      // It doesn't take what the other has begun, and is next.
      expect(wait("codex", codex).result.status).toBe("idle");
      service.passTurn("claude", claude, id);
      expect(wait("codex", codex).result.status).toBe("turn");
      expect(queue()).toEqual(["codex:active"]);
    });

    it("gives no turn to a session after its stop, in either order", () => {
      service.postUserMessage(ROOM, "@codex work");
      ask();
      expect(wait("codex", codex).result).toMatchObject({ reason: "stopped" });
      expect(queue()).toEqual(["codex:queued"]);
    });

    it("lets a turn that had begun go on", () => {
      service.postUserMessage(ROOM, "@codex work");
      turn("codex", codex);
      ask();
      expect(queue()).toEqual(["codex:active"]);
      expect(view().after).toBe("turn");
    });

    it("skips a turn that times out as today, keeps its one retry for it, and stays asked", () => {
      db.prepare("UPDATE rooms SET auto_continue = 1").run();
      service.postUserMessage(ROOM, "@codex work");
      turn("codex", codex);
      service.acquireLock("codex", codex, "/tmp/x", "y", 240);
      ask();
      for (let i = 0; i < 3; i += 1) {
        now += 31 * 60_000;
        service.tick();
      }
      const retries = () =>
        db
          .prepare(
            "SELECT target_agent_id AS agent, state FROM automatic_continuations",
          )
          .all();
      expect(queue()).toEqual([]);
      expect(retries()).toEqual([{ agent: "codex", state: "pending" }]);
      expect(session(codex).state).toBe("active");
      expect(view().state).toBe("asked");
      expect(db.prepare("SELECT 1 FROM write_locks").all()).toHaveLength(1);
      expect(wait("codex", codex).result).toMatchObject({ reason: "stopped" });
      expect(retries()).toEqual([{ agent: "codex", state: "pending" }]);
      // It is there when the agent is back.
      const joined = service.join("codex", ROOM).session_id;
      wait("codex", joined);
      service.tick();
      expect(queue()).toEqual(["codex:queued"]);
    });

    it("keeps a format waiting for its step, until it is skipped or comes back", () => {
      service.startFormat(roomId, {
        kind: "review",
        topic: "x",
        rounds: 1,
        author: "codex",
        reviewers: ["claude"],
      } as never);
      ask();
      wait("codex", codex);
      expect(wait("claude", claude).result.status).toBe("idle");
      expect(queue()).toEqual(["codex:queued"]);
      service.controlFormat(roomId, "skip");
      expect(wait("claude", claude).result.status).toBe("turn");
    });

    it("refuses a hand-off to it, and continues nothing by itself", () => {
      service.postUserMessage(ROOM, "@claude work");
      const id = turn("claude", claude);
      ask();
      const posted = service.postAgentMessage("claude", claude, id, "Done", {
        kind: "lead",
      }) as { message_id: number };
      expect(() =>
        service.handOff("claude", claude, posted.message_id, "codex"),
      ).toThrow(/The lead stopped codex/);
      expect(service.postUserMessage(ROOM, "@codex hello")).toMatchObject({
        unreachable: [{ agent_id: "codex", state: "stopped" }],
      });
      for (let i = 0; i < 5; i += 1) {
        now += 10 * 60_000;
        service.poll("claude", claude, true);
        service.tick();
      }
      expect(queue()).toEqual(["codex:queued"]);
    });

    it("stops after the last of several parallel answers", () => {
      db.prepare("UPDATE rooms SET parallel_lead_mentions = 1").run();
      service.postUserMessage(ROOM, "@codex one");
      const first = turn("codex", codex);
      service.postUserMessage(ROOM, "@codex two");
      ask();
      expect(
        service.postAgentMessage("codex", codex, first, "One", {
          kind: "lead",
        }),
      ).toMatchObject({ stopped: true });
      // The other stays queued for it; nobody else is held up.
      expect(queue()).toEqual(["codex:queued"]);
      service.postUserMessage(ROOM, "@claude three");
      expect(wait("claude", claude).result.status).toBe("turn");
    });
  });

  describe("the run window", () => {
    it("goes on with its rest, however often it is stopped, and through restarts", () => {
      for (let i = 1; i <= 5; i += 1) {
        now += HOUR / 2;
        service.poll("codex", codex, true);
        ask();
        wait("codex", codex);
        expect(saved()).toBe(5 * HOUR - (i * HOUR) / 2);
        service = create();
        service.recoverAfterRestart();
        now += HOUR;
        codex = service.join("codex", ROOM, CODEX).session_id;
        expect(left(codex)).toBe(5 * HOUR - (i * HOUR) / 2);
        expect(saved()).toBeNull();
        wait("codex", codex);
      }
    });

    it("isn't stored by a stop that is only asked or undone, and runs on", () => {
      service.postUserMessage(ROOM, "@codex work");
      turn("codex", codex);
      ask();
      now += HOUR;
      expect(saved()).toBeNull();
      expect(left(codex)).toBe(4 * HOUR);
      keep();
      expect(saved()).toBeNull();
      expect(left(codex)).toBe(4 * HOUR);
    });

    it("ends as the window's end when that comes first", () => {
      service.postUserMessage(ROOM, "@codex work");
      const id = turn("codex", codex);
      ask();
      now += 6 * HOUR;
      service.reportStatus("codex", codex, "working", "x");
      service.passTurn("codex", codex, id);
      expect(session(codex).end_reason).toBe("run_window_ended");
      expect(saved()).toBeNull();
    });

    it("isn't written again by a break, in either order", () => {
      service.postUserMessage(ROOM, "@codex work");
      const id = turn("codex", codex);
      ask();
      now += HOUR;
      service["startBreak"](roomId);
      expect(saved()).toBe(4 * HOUR);
      now += HOUR;
      service.passTurn("codex", codex, id);
      expect(saved()).toBe(4 * HOUR);
      const joined = service.join("codex", ROOM, CODEX).session_id;
      wait("codex", joined);
      now += HOUR;
      service.poll("codex", joined, true);
      ask();
      expect(saved()).toBe(3 * HOUR);
      service["startBreak"](roomId);
      expect(saved()).toBe(3 * HOUR);
    });

    it("keeps frozen time in a pause, and is stored also when the stop never arrives", () => {
      service.setRoomPaused(roomId, true);
      now += 2 * HOUR;
      service.poll("codex", codex, true);
      ask();
      expect(saved()).toBe(5 * HOUR);
      expect(view().state).toBe("undelivered");
    });
  });

  describe("permissions outside a turn", () => {
    const permission = () =>
      service.requestPermission("codex", codex, {
        recipient: "example.com",
        data_description: "x",
        reason: "y",
      }).id;

    it("count as work, and the answer reaches it before it stops", () => {
      const id = permission();
      now += 31_000;
      service.getPermission("codex", codex, id);
      expect(view().can).toBe("after_work");
      ask();
      expect(view()).toMatchObject({ state: "asked", open_permission: true });
      service.decidePermission(id, "approved");
      expect(service.getPermission("codex", codex, id).state).toBe("approved");
      expect(wait("codex", codex).result).toMatchObject({ reason: "stopped" });
    });

    it("are refused after it has ended; a new session needs the number", () => {
      const id = permission();
      service.beginObservedWait("codex", codex, "held");
      service.poll("codex", codex, true);
      ask();
      expect(view()).toMatchObject({
        state: "undelivered",
        open_permission: true,
      });
      service.decidePermission(id, "approved");
      expect(() => service.getPermission("codex", codex, id)).toThrow(
        STOP_INSTRUCTIONS,
      );
      const joined = service.join("codex", ROOM).session_id;
      expect(service.getPermission("codex", joined, id).state).toBe("approved");
    });
  });

  it("leaves nothing of a stop when any statement of it fails", () => {
    const snapshot = () =>
      JSON.stringify(
        ["sessions", "events", "room_members", "write_locks"].map((table) =>
          db.prepare(`SELECT * FROM ${table}`).all(),
        ),
      );
    service.acquireLock("codex", codex, "/tmp/x", "y");
    const before = snapshot();
    const prepare = db.prepare.bind(db);
    let failures = 0;
    for (let at = 1; ; at += 1) {
      let count = 0;
      vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        const statement = prepare(sql);
        if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
          const run = statement.run.bind(statement);
          statement.run = ((...values: unknown[]) => {
            const result = run(...values);
            count += 1;
            if (count === at) throw new Error("disk full");
            return result;
          }) as typeof statement.run;
        }
        return statement;
      }) as typeof db.prepare);
      let failed = false;
      try {
        ask();
      } catch {
        failed = true;
      }
      vi.restoreAllMocks();
      if (!failed) break;
      failures += 1;
      expect(snapshot()).toBe(before);
    }
    expect(failures).toBeGreaterThan(4);
    expect(session(codex).end_reason).toBe("stopped");
  });

  it("keeps post and stop together when the end of the session fails", () => {
    service.postUserMessage(ROOM, "@codex work");
    const id = turn("codex", codex);
    ask();
    vi.spyOn(
      service as unknown as { endSession: () => void },
      "endSession",
    ).mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() =>
      service.postAgentMessage("codex", codex, id, "Done", { kind: "lead" }),
    ).toThrow("disk full");
    vi.restoreAllMocks();
    expect(queue()).toEqual(["codex:active"]);
    expect(
      db.prepare("SELECT 1 FROM messages WHERE sender_id = 'codex'").all(),
    ).toEqual([]);
    service.postAgentMessage("codex", codex, id, "Done", { kind: "lead" });
    expect(session(codex).end_reason).toBe("stopped");
  });

  it("goes on through a restart of Konfab at every state, and tells nothing that wasn't", () => {
    const restart = () => {
      service = create();
      service.recoverAfterRestart();
    };
    service.postUserMessage(ROOM, "@codex work");
    const id = turn("codex", codex);
    ask();
    restart();
    expect(view()).toMatchObject({ state: "asked", after: "turn" });
    service.passTurn("codex", codex, id);
    restart();
    expect(view().state).toBe("answered");
    service.stops.received(codex);
    restart();
    expect(view().state).toBe("received");
    const joined = service.join("codex", ROOM).session_id;
    wait("codex", joined);
    ask();
    restart();
    expect(view().state).toBe("undelivered");
  });

  it("shows the room who was stopped, and other agents nothing of it", () => {
    ask();
    wait("codex", codex);
    expect(service.roomState(ROOM).stops).toMatchObject([
      { agent_id: "codex", kind: "stopped" },
    ]);
    // The export lists it with the other activity, and nowhere else.
    expect(
      service.exportRoom(ROOM).markdown.split("## Activity")[0],
    ).not.toContain("stop asked");
    expect(
      JSON.stringify(service.join("claude", ROOM).recent_messages),
    ).not.toContain("stop");
  });
});
