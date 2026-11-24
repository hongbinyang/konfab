import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import {
  CLOSED,
  conversationId,
  newNumber,
  rejoinMessage,
} from "../../src/server/domain/rejoin.js";
import { KonfabService } from "../../src/server/domain/service.js";

const ROOM = "rejoin";
const HERE = "019a0000-0000-7000-8000-000000000001";
const OTHER = "019a0000-0000-7000-8000-000000000002";
const LOST_MS = 90_001;

describe("asking agents to rejoin", () => {
  let db: Db;
  let now: number;
  let service: KonfabService;
  let roomId: number;
  let session: string;

  const createService = () => {
    const made = new KonfabService(db, {
      now: () => now,
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 30 * 60_000,
      maxMessageChars: 1000,
    });
    made.rejoin.available = () => true;
    return made;
  };
  const view = (room = roomId) => service.rejoin.view(room, "codex");
  const ask = (again = false) => service.rejoin.ask(roomId, "codex", again);
  const rejoin = (
    number: unknown,
    conversation: unknown = HERE,
    app = "codex",
  ) =>
    service.rejoin.rejoin(app, number, conversation) as { session_id?: string };
  const sessions = () =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sessions WHERE room_id = ? AND agent_id = 'codex'",
        )
        .get(roomId) as { n: number }
    ).n;
  const states = () =>
    (
      db
        .prepare("SELECT state, reason FROM rejoin_requests ORDER BY id")
        .all() as {
        state: string;
        reason: string | null;
      }[]
    ).map((row) => (row.reason ? `${row.state}:${row.reason}` : row.state));
  const events = () =>
    service
      .activity(ROOM)
      .filter((event) => event.agent_id === "codex")
      .map((event) => event.type)
      .filter((type) => /^rejoin(ed|_)/.test(type))
      .reverse();
  const loseContact = () => {
    now += LOST_MS;
    service.tick();
  };
  const other = () => {
    service.createRoom("elsewhere", "", ["codex"]);
    return service.join("codex", "elsewhere", HERE).session_id;
  };

  beforeEach(() => {
    now = 1_800_000_000_000;
    db = openDatabase(":memory:");
    service = createService();
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    service.createRoom(ROOM, "", ["claude", "codex"]);
    roomId = service["room"](ROOM).id;
    session = service.join("codex", ROOM, HERE).session_id;
    service.poll("codex", session, true);
    loseContact();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("makes unpredictable numbers and a prompt that is byte for byte fixed", () => {
    const numbers = new Set(Array.from({ length: 2000 }, newNumber));
    expect(numbers.size).toBe(2000);
    for (const number of numbers)
      expect(number).toMatch(/^[A-HJKMNP-TV-Z0-9]{26}$/);
    expect(rejoinMessage("ABC")).toBe(
      'Konfab: the lead asked you to rejoin a room. Call the Konfab tool rejoin_room with request "ABC" and follow its answer. If it says the request is closed, end your turn and do nothing else.',
    );
  });

  it("accepts only a lower-case UUID as a conversation", () => {
    expect(conversationId(HERE)).toBe(HERE);
    for (const value of [
      HERE.toUpperCase(),
      `${HERE} `,
      `${HERE}\n`,
      HERE.replaceAll("-", ""),
      "",
      "--help",
      undefined,
      null,
      7,
      [HERE],
    ])
      expect(conversationId(value)).toBeNull();
  });

  it("goes from asked to joined to back, and only a wait makes it back", () => {
    expect(view()).toEqual({ offer: "ready", request: null, earlier: false });
    const asked = ask();
    expect(asked.conversation).toBe(HERE);
    service.rejoin.sent(asked.id, "taken");
    expect(view()).toMatchObject({
      offer: null,
      request: { state: "waiting", unsure: false, slow: false },
    });
    now += 60_000;
    expect(view().request?.slow).toBe(true);
    const joined = rejoin(asked.number);
    expect(joined).toMatchObject({ room: ROOM });
    expect(joined.session_id).not.toBe(session);
    expect(view().request).toMatchObject({ state: "joined", slow: false });
    // Neither a status report nor the connector's own checks are a wait.
    service.reportStatus("codex", joined.session_id!, "working", "Reading");
    service.poll("codex", joined.session_id!, false);
    expect(view().request?.state).toBe("joined");
    now += 60_000;
    expect(view().request).toMatchObject({ state: "joined", slow: true });
    service.poll("codex", joined.session_id!, true);
    expect(view().request).toBeNull();
    expect(states()).toEqual(["back"]);
    expect(events()).toEqual(["rejoin_asked", "rejoin_joined", "rejoined"]);
    expect(service.poll("codex", session, true).status).toBe("replaced");
  });

  it("answers as join_room does", () => {
    const keys = Object.keys(service.join("claude", ROOM));
    expect(Object.keys(rejoin(ask().number))).toEqual(keys);
  });

  it("takes a call that comes before the command's own answer", () => {
    const asked = ask();
    expect(rejoin(asked.number).session_id).toBeTruthy();
    for (const result of ["refused", "unsure", "taken"] as const)
      service.rejoin.sent(asked.id, result);
    expect(states()).toEqual(["joined"]);
  });

  it("answers the same session when the call is repeated, and never makes a second one", () => {
    const { number } = ask();
    const first = rejoin(number).session_id;
    expect(rejoin(number).session_id).toBe(first);
    service.poll("codex", first!, true);
    expect(rejoin(number).session_id).toBe(first);
    expect(sessions()).toBe(2);
    expect(events().filter((type) => type === "rejoin_joined")).toHaveLength(1);
    expect(rejoin(number, OTHER)).toEqual(CLOSED);
    expect(rejoin(number, HERE, "claude")).toEqual(CLOSED);
    // Replaced by an ordinary join: closed from then on.
    service.join("codex", ROOM, HERE);
    expect(rejoin(number)).toEqual(CLOSED);
    expect(sessions()).toBe(3);
  });

  it.each([
    ["guessed", () => newNumber(), HERE, "codex"],
    ["lower-case number", (n: string) => n.toLowerCase(), HERE, "codex"],
    ["longer", (n: string) => `${n}A`, HERE, "codex"],
    ["not a string", () => ({}), HERE, "codex"],
    ["another app", (n: string) => n, HERE, "claude"],
    ["another conversation", (n: string) => n, OTHER, "codex"],
    ["no conversation", (n: string) => n, null, "codex"],
    ["malformed conversation", (n: string) => n, "x", "codex"],
    ["upper-case conversation", (n: string) => n, HERE.toUpperCase(), "codex"],
  ] as [string, (n: string) => unknown, unknown, string][])(
    "answers only closed to a call that is wrong: %s",
    (_name, number, conversation, app) => {
      const asked = ask();
      expect(rejoin(number(asked.number), conversation, app)).toEqual(CLOSED);
      expect(sessions()).toBe(1);
      // The right call still works.
      expect(rejoin(asked.number).session_id).toBeTruthy();
    },
  );

  it.each([
    ["cancelled", () => service.rejoin.cancel(roomId, "codex"), "cancelled"],
    ["expired", () => void (now += 10 * 60_000), "expired"],
    ["clock set back", () => void (now -= 1), "expired"],
    ["room paused", () => service.setRoomPaused(roomId, true), "changed"],
    ["all paused", () => service.setAllPaused(true), "changed"],
    ["break", () => service["startBreak"](roomId), "changed"],
    ["archived", () => service.archiveRoom(roomId), "changed"],
    ["removed", () => service.setMembers(roomId, ["claude"]), "changed"],
    ["ordinary join", () => void service.join("codex", ROOM, HERE), "replaced"],
  ] as [string, () => void, string][])(
    "closes a request that isn't wanted any more: %s",
    (name, change, reason) => {
      const { id, number } = ask();
      service.rejoin.sent(id, "taken");
      change();
      const before = sessions();
      const room = { ...service["room"](ROOM) };
      expect(rejoin(number)).toEqual(CLOSED);
      expect(sessions()).toBe(before);
      expect(service["room"](ROOM)).toMatchObject({
        paused: room.paused,
        on_break: room.on_break,
        archived_at: room.archived_at,
      });
      expect(states()).toEqual([`closed:${reason}`]);
      expect(events()).toEqual(["rejoin_asked", "rejoin_closed"]);
      const closed = db
        .prepare("SELECT closed_at FROM rejoin_requests")
        .get() as { closed_at: number };
      expect(closed.closed_at).toBe(now);
      // Undoing it doesn't make the old one wanted again.
      if (name === "room paused") service.setRoomPaused(roomId, false);
      if (name === "all paused") service.setAllPaused(false);
      expect(rejoin(number)).toEqual(CLOSED);
    },
  );

  it("never ends a break, even for a request that was somehow left open", () => {
    const { number } = ask();
    db.exec("DROP TRIGGER rejoin_room_changed");
    service["startBreak"](roomId);
    expect(rejoin(number)).toEqual(CLOSED);
    expect(service["room"](ROOM).on_break).toBe(1);
    expect(states()).toEqual(["closed:changed"]);
  });

  it("stays joined through a pause, a break or expiry, and isn't back without a wait that counts", () => {
    const { number } = ask();
    const joined = rejoin(number).session_id!;
    expect(() => service.rejoin.cancel(roomId, "codex")).toThrow(
      /already joined/,
    );
    now += 11 * 60_000;
    service.tick();
    service.setRoomPaused(roomId, true);
    expect(states()).toEqual(["joined"]);
    service.setRoomPaused(roomId, false);
    service["startBreak"](roomId);
    expect(service.poll("codex", joined, true).status).toBe("closed");
    expect(states()).toEqual(["joined"]);
    expect(view().request).toBeNull();
  });

  it("is back when a wait answers with a turn, also in a paused room", () => {
    const { number } = ask();
    const joined = rejoin(number).session_id!;
    service.setRoomPaused(roomId, true);
    service.poll("codex", joined, true);
    expect(states()).toEqual(["back"]);
  });

  it("closes a joined request when an ordinary join replaces it or the agent is removed", () => {
    rejoin(ask().number);
    service.join("codex", ROOM, OTHER);
    service.tick();
    expect(states()).toEqual(["closed:replaced"]);
    loseContact();
    rejoin(ask().number, OTHER);
    service.setMembers(roomId, ["claude"]);
    expect(states()).toEqual(["closed:replaced", "closed:changed"]);
  });

  it("doesn't stop the lead from asking again when a joined agent never waited", () => {
    const { number } = ask();
    const joined = rejoin(number).session_id;
    expect(view().offer).toBeNull();
    expect(() => ask()).toThrow(/already asked/);
    loseContact();
    expect(view()).toMatchObject({
      offer: "ready",
      request: { state: "joined", slow: true },
      earlier: false,
    });
    // Until then the same call is still answered, with the same session.
    expect(rejoin(number).session_id).toBe(joined);
    loseContact();
    const second = ask();
    expect(states()).toEqual(["closed:lost", "sending"]);
    expect(rejoin(number)).toEqual(CLOSED);
    expect(rejoin(second.number).session_id).not.toBe(joined);
  });

  it("leaves no part of a rejoin when any statement of it fails", () => {
    const { number } = ask();
    const snapshot = () =>
      JSON.stringify(
        [
          "sessions",
          "rejoin_requests",
          "events",
          "turns",
          "room_members",
          "rooms",
        ].map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
      );
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
        rejoin(number);
      } catch {
        failed = true;
      }
      vi.restoreAllMocks();
      if (!failed) break;
      failures += 1;
      expect(snapshot()).toBe(before);
    }
    // Every write was made to fail once.
    expect(failures).toBeGreaterThan(5);
    expect(states()).toEqual(["joined"]);
    expect(sessions()).toBe(2);
  });

  it("leaves no part of a rejoin when its answer can't be made", () => {
    const { number } = ask();
    vi.spyOn(
      service as unknown as { joinReply: () => void },
      "joinReply",
    ).mockImplementation(() => {
      throw new Error("no");
    });
    expect(() => rejoin(number)).toThrow("no");
    vi.restoreAllMocks();
    expect(states()).toEqual(["sending"]);
    expect(sessions()).toBe(1);
    expect(rejoin(number).session_id).toBeTruthy();
  });

  it("is back only together with the wait itself", () => {
    const joined = rejoin(ask().number).session_id!;
    vi.spyOn(
      service as unknown as { activateNext: () => void },
      "activateNext",
    ).mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => service.poll("codex", joined, true)).toThrow("disk full");
    expect(states()).toEqual(["joined"]);
  });

  it.each([
    ["taken", "waiting", false],
    ["unsure", "waiting", true],
    ["refused", "closed:refused", false],
  ] as const)(
    "keeps what became of the prompt: %s",
    (result, state, unsure) => {
      const asked = ask();
      service.rejoin.sent(asked.id, result);
      expect(states()).toEqual([state]);
      expect(view().request).toMatchObject({
        state: state.split(":")[0],
        unsure,
        refused: result === "refused",
      });
      // Only a refusal means that nothing is waiting in Codex.
      if (result === "refused") {
        expect(view()).toMatchObject({ offer: "ready", earlier: false });
        expect(rejoin(asked.number)).toEqual(CLOSED);
      } else expect(rejoin(asked.number).session_id).toBeTruthy();
    },
  );

  it("allows one open request, and says when an earlier prompt may still be in Codex", () => {
    const first = ask();
    expect(() => ask(true)).toThrow(/already asked/);
    service.rejoin.sent(first.id, "taken");
    service.rejoin.cancel(roomId, "codex");
    expect(() => service.rejoin.cancel(roomId, "codex")).toThrow(/No rejoin/);
    expect(view()).toMatchObject({
      offer: "ready",
      earlier: true,
      request: { state: "closed", refused: false },
    });
    expect(() => ask()).toThrow(/already be waiting/);
    const second = ask(true);
    expect(rejoin(first.number)).toEqual(CLOSED);
    const joined = rejoin(second.number).session_id!;
    service.poll("codex", joined, true);
    loseContact();
    // The later one arrived, so the earlier one did too.
    expect(view()).toEqual({ offer: "ready", request: null, earlier: false });
  });

  it("recovers from a stop of Konfab without sending or extending anything", () => {
    const { number } = ask();
    service = createService();
    service.recoverAfterRestart();
    expect(view().request).toMatchObject({ state: "waiting", unsure: true });
    expect(states()).toEqual(["waiting"]);
    now += 10 * 60_000;
    service = createService();
    service.recoverAfterRestart();
    expect(states()).toEqual(["closed:expired"]);
    expect(rejoin(number)).toEqual(CLOSED);
  });

  it("accepts a wanted call right after a restart, when every agent counts as in contact", () => {
    other();
    loseContact();
    const { number } = ask();
    service = createService();
    service.recoverAfterRestart();
    now += 1000;
    expect(rejoin(number).session_id).toBeTruthy();
    expect(sessions()).toBe(2);
  });

  it.each([
    ["waits", () => void service.poll("codex", session, true)],
    [
      "is polled by its connector",
      () => void service.poll("codex", session, false),
    ],
    [
      "reports work",
      () => void service.reportStatus("codex", session, "working", "Reading"),
    ],
    ["joins another room in that conversation", () => void other()],
  ] as [string, () => void][])(
    "closes a request when the agent %s, also after its contact is lost again",
    (_name, call) => {
      const { id, number } = ask();
      service.rejoin.sent(id, "taken");
      now += 1000;
      call();
      expect(states()).toEqual(["closed:contact"]);
      // Longer than a working agent may be quiet, and well before it expires.
      now += 6 * 60_000;
      service.tick();
      expect(view().offer).toBe("ready");
      expect(now).toBeLessThan(
        (
          db.prepare("SELECT expires_at AS at FROM rejoin_requests").get() as {
            at: number;
          }
        ).at,
      );
      expect(rejoin(number)).toEqual(CLOSED);
      expect(sessions()).toBe(1);
      expect(events()).toEqual(["rejoin_asked", "rejoin_closed"]);
    },
  );

  it.each([["here"], ["elsewhere"]])(
    "doesn't rely on triggers alone to see a call %s since the request",
    (where) => {
      const there = other();
      loseContact();
      const { number } = ask();
      db.exec("DROP TRIGGER rejoin_called_again");
      now += 1000;
      service.poll("codex", where === "here" ? session : there, true);
      loseContact();
      expect(states()).toEqual(["sending"]);
      expect(rejoin(number)).toEqual(CLOSED);
      expect(states()).toEqual(["closed:changed"]);
    },
  );

  it("isn't closed by another agent's or conversation's calls", () => {
    const claude = service.join("claude", ROOM, OTHER).session_id;
    const { number } = ask();
    now += 1000;
    service.poll("claude", claude, true);
    service.join("claude", ROOM, OTHER);
    expect(rejoin(number).session_id).toBeTruthy();
  });

  it("is closed for what it was asked for, and can be asked again after contact was lost again", () => {
    const first = ask();
    now += 1000;
    service.poll("codex", session, true);
    loseContact();
    expect(view().earlier).toBe(true);
    const second = ask(true);
    expect(rejoin(first.number)).toEqual(CLOSED);
    expect(rejoin(second.number).session_id).toBeTruthy();
  });

  it("keeps a joined request through a stop of Konfab, and it is still not back", () => {
    const { number } = ask();
    const joined = rejoin(number).session_id;
    service = createService();
    service.recoverAfterRestart();
    expect(states()).toEqual(["joined"]);
    expect(rejoin(number).session_id).toBe(joined);
  });

  it("follows the configured limit", () => {
    service.rejoin.wantedMs = 60_000;
    const { number } = ask();
    now += 59_999;
    service.tick();
    expect(states()).toEqual(["sending"]);
    now += 1;
    expect(rejoin(number)).toEqual(CLOSED);
  });

  it.each([
    ["archived", () => service.archiveRoom(roomId)],
    ["paused", () => service.setRoomPaused(roomId, true)],
    ["paused", () => service.setAllPaused(true)],
    ["on_break", () => service["startBreak"](roomId)],
    ["elsewhere", () => void other()],
  ] as [string, () => void][])("isn't offered when %s", (reason, change) => {
    change();
    expect(view().offer).toBe(reason);
    expect(() => ask()).toThrow(/can't be asked/);
    expect(states()).toEqual([]);
  });

  it("says why it can't be used now, and can't be used then", () => {
    service.rejoin.available = () => false;
    expect(view().offer).toBeNull();
    service.rejoin.problem = () => true;
    expect(view().offer).toBe("unavailable");
    expect(() => ask()).toThrow(/can't be asked/);
    service.rejoin.available = () => true;
    expect(view().offer).toBe("ready");
    const joined = service.join("codex", ROOM, HERE).session_id;
    expect(view().offer).toBe("connected");
    service.poll("codex", joined, true);
    expect(view().offer).toBe("connected");
    expect(() => ask()).toThrow(/can't be asked/);
    // A newer join that named none: an older one isn't used instead.
    service.join("codex", ROOM, "not-one");
    expect(view().offer).toBe("old_join");
    loseContact();
    expect(view().offer).toBe("old_join");
    expect(() => ask()).toThrow(/can't be asked/);
    expect(states()).toEqual([]);
  });

  it("works for the same app under another name", () => {
    service.ensureAgent("builder", "Builder");
    service.setMembers(roomId, ["claude", "codex", "builder"]);
    const of = () => service.rejoin.view(roomId, "builder");
    // Nothing tells it apart before its connector has named a conversation.
    service.join("builder", ROOM);
    loseContact();
    expect(of().offer).toBeNull();
    const joined = service.join("builder", ROOM, OTHER).session_id;
    service.poll("builder", joined, true);
    expect(of().offer).toBe("connected");
    loseContact();
    expect(of().offer).toBe("ready");
    const { number } = service.rejoin.ask(roomId, "builder", false);
    expect(rejoin(number, OTHER, "codex")).toEqual(CLOSED);
    const back = rejoin(number, OTHER, "builder").session_id!;
    service.poll("builder", back, true);
    expect(states()).toEqual(["back"]);
    // An older connector in one of its conversations is explained.
    service.join("builder", ROOM);
    loseContact();
    expect(of().offer).toBe("old_join");
    service.rejoin.available = () => false;
    service.rejoin.problem = () => true;
    expect(of().offer).toBe("unavailable");
  });

  it("shows nothing for agents of other apps and ones that never joined", () => {
    service.join("claude", ROOM);
    loseContact();
    service.ensureAgent("codex2", "Second");
    db.prepare("UPDATE agents SET app_id = 'codex' WHERE id = 'codex2'").run();
    service.setMembers(roomId, ["claude", "codex", "codex2"]);
    service.rejoin.problem = () => true;
    for (const available of [true, false]) {
      service.rejoin.available = () => available;
      expect(service.rejoin.view(roomId, "claude").offer).toBeNull();
      expect(service.rejoin.view(roomId, "codex2").offer).toBeNull();
    }
    service.rejoin.available = () => true;
    expect(() => service.rejoin.ask(roomId, "claude", true)).toThrow(
      /can't be asked/,
    );
  });

  it("tells the room when an agent is back: at its first wait after joining again", () => {
    const back = () =>
      service
        .roomState(ROOM)
        .returns.map((item) => [item.agent_id, item.created_at]);
    // The first join isn't a return, and neither is a join without a wait.
    expect(back()).toEqual([]);
    service.poll("claude", service.join("claude", ROOM).session_id, true);
    const joined = service.join("codex", ROOM, HERE).session_id;
    expect(back()).toEqual([]);
    service.poll("codex", joined, false);
    expect(back()).toEqual([]);
    now += 1000;
    service.poll("codex", joined, true);
    const first = now;
    now += 1000;
    service.poll("codex", joined, true);
    expect(back()).toEqual([["codex", first]]);
    // A join that never waits is not counted by the next one's wait.
    service.join("codex", ROOM, HERE);
    now += 1000;
    loseContact();
    const again = rejoin(ask().number).session_id!;
    expect(back()).toEqual([["codex", first]]);
    service.poll("codex", again, true);
    expect(back()).toEqual([
      ["codex", first],
      ["codex", now],
    ]);
    // Other rooms have their own.
    service.poll("codex", other(), true);
    expect(back()).toHaveLength(2);
    expect(service.roomState("elsewhere").returns).toEqual([]);
  });

  it("doesn't take the conversation from a room where it is waiting", () => {
    const { number } = ask();
    other();
    expect(rejoin(number)).toEqual(CLOSED);
    expect(states()).toEqual(["closed:contact"]);
  });

  it("allows one open request per conversation over all rooms", () => {
    other();
    loseContact();
    const elsewhere = service["room"]("elsewhere").id;
    ask();
    expect(view(elsewhere).offer).toBe("elsewhere");
    expect(() => service.rejoin.ask(elsewhere, "codex", true)).toThrow(
      /can't be asked/,
    );
  });

  it("goes only to the newest conversation", () => {
    const { number } = ask();
    service.join("codex", ROOM, OTHER);
    loseContact();
    expect(rejoin(number)).toEqual(CLOSED);
    expect(ask().conversation).toBe(OTHER);
  });

  it("stores the number only as a hash, and shows neither it nor the conversation", () => {
    const { number } = ask();
    const joined = rejoin(number);
    service.poll("codex", joined.session_id!, true);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const where: string[] = [];
    for (const { name } of tables) {
      const text = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
      expect(text, name).not.toContain(number);
      if (text.includes(HERE)) where.push(name);
    }
    expect(where.sort()).toEqual(["rejoin_requests", "sessions"]);
    for (const shown of [
      joined,
      service.roomState(ROOM),
      service.activity(ROOM),
    ]) {
      expect(JSON.stringify(shown)).not.toContain(number);
      expect(JSON.stringify(shown)).not.toContain(HERE);
    }
  });
});
