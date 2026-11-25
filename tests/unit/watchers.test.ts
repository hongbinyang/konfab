import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";
import {
  macProcesses,
  type Looked,
  type Run,
} from "../../src/server/rejoin/processes.js";
import { RefusedWatch, Watchers } from "../../src/server/rejoin/watchers.js";

const ROOM = "watch";
const HERE = "019a0000-0000-4000-8000-000000000001";
const OTHER = "019a0000-0000-4000-8000-000000000002";
const DAY = 24 * 60 * 60_000;
const SCRIPT = "/konfab/dist/cli/watch.js";

describe("watchers", () => {
  let db: Db;
  let now: number;
  let service: KonfabService;
  let root: string;
  let folder: string;
  let watchers: Watchers;
  let roomId: number;
  let session: string;
  let table: Map<number, Looked>;
  let boot: string | null;
  let nextPid: number;
  let broken: AbortController[];

  const create = () => {
    const made = new KonfabService(db, {
      now: () => now,
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 30 * 60_000,
      maxMessageChars: 1000,
    });
    Object.assign(made, { startedAt: 0 });
    return made;
  };
  const createWatchers = () => {
    const made = new Watchers({
      db,
      rejoin: service.rejoin,
      folder,
      script: SCRIPT,
      node: "/node's/bin/node",
      port: 8787,
      uid: process.getuid!(),
      processes: {
        look: (pid) => table.get(pid) ?? "none",
        boot: () => boot,
      },
      now: () => now,
      isWaiting: (agent, conversation) =>
        service.isWaitingIn(agent, conversation),
    });
    made.enabled = true;
    service.rejoin.watchers = (app, agent, conversation) =>
      made.state(app, agent, conversation);
    return made;
  };
  type Started = { id: number; pid: number; ticket: string };
  const pathOf = (command: string) => /'([^']+)'$/.exec(command)![1]!;
  /** What the agent would start, and its first look at the ticket. */
  const start = (conversation = HERE, agent = "claude"): Started => {
    const offer = watchers.offer("claude", agent, conversation);
    if (!offer || !("command" in offer)) throw new Error("no command");
    const path = pathOf(offer.command);
    const pid = (nextPid += 1);
    table.set(pid, {
      state: "there",
      uid: process.getuid!(),
      start: `Mon Nov 23 10:00:${pid % 60} 2026`,
      command: `node ${SCRIPT} ${path}`,
    });
    return {
      id: Number(path.split("/").at(-1)),
      pid,
      ticket: JSON.parse(readFileSync(path, "utf8")).ticket as string,
    };
  };
  const call = (started: Started, changes: Partial<Started> = {}) => {
    const gone = new AbortController();
    broken.push(gone);
    return watchers.watch(
      changes.ticket ?? started.ticket,
      changes.pid ?? started.pid,
      gone.signal,
    );
  };
  const row = (id: number) =>
    db.prepare("SELECT * FROM watchers WHERE id = ?").get(id) as {
      state: string;
      ticket_hash: string | null;
      pid: number | null;
    };
  const view = () => service.rejoin.view(roomId, "claude");
  const ask = (again = false) => service.rejoin.ask(roomId, "claude", again);
  const files = () => (existsSync(folder) ? readdirSync(folder) : []);
  const away = () => {
    now += 90_001;
    service.tick();
  };
  const requests = () =>
    (
      db
        .prepare(
          "SELECT state, reason, unsure FROM rejoin_requests ORDER BY id",
        )
        .all() as { state: string; reason: string | null; unsure: number }[]
    ).map(
      (item) =>
        `${item.state}${item.reason ? `:${item.reason}` : ""}${item.unsure ? "?" : ""}`,
    );
  /** The lead's click, as the page's route does it. */
  const click = async (again = false) => {
    const asked = ask(again);
    const sending = watchers.send(asked);
    return {
      asked,
      result: sending.then((result) => {
        service.rejoin.sent(asked.id, result);
        return result;
      }),
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_800_000_000_000;
    nextPid = 1000;
    table = new Map();
    boot = "A";
    broken = [];
    root = mkdtempSync(join(tmpdir(), "konfab-watchers-"));
    folder = join(root, "watch");
    db = openDatabase(":memory:");
    service = create();
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    service.createRoom(ROOM, "", ["claude", "codex"]);
    roomId = service["room"](ROOM).id;
    watchers = createWatchers();
    session = service.join("claude", ROOM, HERE, "watch").session_id;
    service.poll("claude", session, true);
    away();
  });
  afterEach(() => {
    for (const gone of broken) gone.abort();
    vi.useRealTimers();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("gives a fixed command whose ticket is only in a private file", () => {
    const offer = watchers.offer("claude", "claude", HERE) as {
      command: string;
      instructions: string;
    };
    expect(offer.command).toBe(
      `'/node'\\''s/bin/node' '${SCRIPT}' '${folder}/1'`,
    );
    const { ticket, port } = JSON.parse(
      readFileSync(join(folder, "1"), "utf8"),
    );
    expect(ticket).toMatch(/^kfw_[A-Za-z0-9_-]{27}$/);
    expect(port).toBe(8787);
    expect(statSync(join(folder, "1")).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(offer)).not.toContain(ticket);
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[])
      expect(
        JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()),
      ).not.toContain(ticket);
    // Asked again before it was started: the same one.
    expect(watchers.offer("claude", "claude", HERE)).toEqual(offer);
    expect(files()).toEqual(["1"]);
  });

  it("offers nothing while it is off, or without a full conversation number", () => {
    for (const odd of [undefined, "", "x", HERE.toUpperCase(), 7])
      expect(watchers.offer("claude", "claude", odd)).toBeUndefined();
    watchers.enabled = false;
    expect(watchers.offer("claude", "claude", HERE)).toBeUndefined();
    expect(files()).toEqual([]);
  });

  it.each([
    [
      "a folder others can open",
      () => {
        mkdirSync(folder, { mode: 0o755 });
        chmodSync(folder, 0o755);
      },
    ],
    [
      "a link instead of the folder",
      () => {
        mkdirSync(join(root, "elsewhere"), { mode: 0o700 });
        symlinkSync(join(root, "elsewhere"), folder);
      },
    ],
  ])("writes no ticket into %s", (_name, prepare) => {
    prepare();
    expect(() => watchers.offer("claude", "claude", HERE)).toThrow(/private/);
    expect(db.prepare("SELECT 1 FROM watchers").all()).toEqual([]);
  });

  it("never writes through a link or over a file", () => {
    mkdirSync(folder, { mode: 0o700 });
    const target = join(root, "target");
    writeFileSync(target, "mine");
    const tidy = vi.spyOn(watchers, "tidy").mockImplementation(() => {});
    symlinkSync(target, join(folder, "1"));
    expect(() => watchers.offer("claude", "claude", HERE)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("mine");
    tidy.mockRestore();
    // What doesn't belong there is taken away first.
    expect(watchers.offer("claude", "claude", HERE)).toBeTruthy();
    expect(readFileSync(target, "utf8")).toBe("mine");
  });

  it("binds the ticket to the process at the first call, and removes its file", async () => {
    const started = start();
    const waiting = call(started);
    expect(row(started.id)).toMatchObject({ state: "live", pid: started.pid });
    expect(files()).toEqual([]);
    expect(view().offer).toBe("ready");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await waiting).toEqual({ status: "wait" });
    // Another process that has read it too is refused, and so it ends.
    await expect(call(started, { pid: 4242 })).rejects.toThrow(RefusedWatch);
    void call(started);
    expect(watchers.offer("claude", "claude", HERE)).toEqual({ running: true });
  });

  it.each([
    ["no such process", () => "none" as Looked],
    ["can't be seen", () => "unknown" as Looked],
    ["another user's", (at: Extract<Looked, object>) => ({ ...at, uid: 1 })],
    [
      "another program",
      (at: Extract<Looked, object>) => ({ ...at, command: "vim" }),
    ],
    [
      "another ticket's watcher",
      (at: Extract<Looked, object>) => ({ ...at, command: `${at.command}9` }),
    ],
    [
      "another script",
      (at: Extract<Looked, object>) => ({
        ...at,
        command: at.command.replace(SCRIPT, "/tmp/watch.js"),
      }),
    ],
  ])(
    "refuses a first call from a process that isn't it: %s",
    async (_n, change) => {
      const started = start();
      table.set(
        started.pid,
        change(table.get(started.pid) as Extract<Looked, object>),
      );
      await expect(call(started)).rejects.toThrow(RefusedWatch);
      expect(row(started.id).state).toBe("issued");
      expect(view().offer).toBe("no_watcher");
    },
  );

  it("refuses a first call when the computer's start can't be told", async () => {
    const started = start();
    boot = null;
    await expect(call(started)).rejects.toThrow(RefusedWatch);
    expect(row(started.id).state).toBe("issued");
  });

  it("refuses wrong tickets, and for a minute after too many", async () => {
    const started = start();
    for (const wrong of [
      undefined,
      "",
      "kfb_x",
      started.ticket.slice(0, -1),
      `${started.ticket}A`,
      started.ticket.toLowerCase(),
    ])
      await expect(
        watchers.watch(wrong, started.pid, new AbortController().signal),
      ).rejects.toThrow(RefusedWatch);
    for (let i = 0; i < 20; i += 1)
      await expect(call(started, { ticket: "kfw_x" })).rejects.toThrow();
    await expect(call(started)).rejects.toThrow(RefusedWatch);
    now += 60_001;
    void call(started);
    expect(row(started.id).state).toBe("live");
  });

  it("is deleted when it isn't started in two minutes, however late it goes on", async () => {
    const started = start();
    now += 2 * 60_000;
    await expect(call(started)).rejects.toThrow(RefusedWatch);
    watchers.tidy();
    expect(row(started.id)).toMatchObject({ state: "gone", ticket_hash: null });
    expect(files()).toEqual([]);
    now += 30 * DAY;
    await expect(call(started)).rejects.toThrow(RefusedWatch);
    expect(
      db.prepare("SELECT 1 FROM watchers WHERE pid IS NOT NULL").all(),
    ).toEqual([]);
  });

  it("hands a request over once, and confirmed means waiting", async () => {
    const started = start();
    const waiting = call(started);
    const { asked, result } = await click();
    const answer = await waiting;
    expect(answer).toMatchObject({ status: "print", request: asked.number });
    expect(row(started.id).state).toBe("used");
    expect(requests()).toEqual(["sending"]);
    const { handover } = answer as { handover: string };
    expect(() => watchers.printed(started.ticket, "wrong")).toThrow(
      RefusedWatch,
    );
    watchers.printed(started.ticket, handover);
    watchers.printed(started.ticket, handover);
    expect(await result).toBe("taken");
    expect(requests()).toEqual(["waiting"]);
    // Never again, to it or to another.
    expect(await call(started)).toEqual({ status: "rest" });
    expect(view().request).toMatchObject({ state: "waiting", unsure: false });
    const joined = service.rejoin.rejoin(
      "claude",
      asked.number,
      HERE,
      "watch",
    ) as { session_id: string };
    service.poll("claude", joined.session_id, true);
    expect(requests()).toEqual(["back"]);
  });

  it("is unsure without a confirmation, and a late one makes it sure while it is wanted", async () => {
    const started = start();
    const waiting = call(started);
    const { result } = await click();
    const { handover } = (await waiting) as { handover: string };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe("unsure");
    expect(requests()).toEqual(["waiting?"]);
    watchers.printed(started.ticket, handover);
    expect(requests()).toEqual(["waiting"]);
    service.rejoin.cancel(roomId, "claude");
    watchers.printed(started.ticket, handover);
    expect(requests()).toEqual(["closed:cancelled"]);
  });

  it("is refused when the call closes and none opens within five seconds", async () => {
    const started = start();
    void call(started);
    broken.at(-1)!.abort();
    expect(view().offer).toBe("ready");
    const { result } = await click();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBe("refused");
    expect(requests()).toEqual(["closed:refused"]);
    expect(row(started.id).state).toBe("live");
  });

  it("uses a call that opens within five seconds", async () => {
    const started = start();
    void call(started);
    broken.at(-1)!.abort();
    const { result } = await click();
    await vi.advanceTimersByTimeAsync(2_000);
    const answer = (await call(started)) as {
      status: string;
      handover: string;
    };
    expect(answer.status).toBe("print");
    watchers.printed(started.ticket, answer.handover);
    expect(await result).toBe("taken");
  });

  it.each([
    ["cancelled", () => service.rejoin.cancel(roomId, "claude")],
    ["expired", () => void (now += 10 * 60_000)],
    ["paused", () => service.setRoomPaused(roomId, true)],
    ["all paused", () => service.setAllPaused(true)],
    ["break", () => service["startBreak"](roomId)],
    ["archived", () => service.archiveRoom(roomId)],
    ["removed", () => service.setMembers(roomId, ["codex"])],
    ["joined", () => void service.join("claude", ROOM, HERE, "watch")],
    ["called", () => void service.poll("claude", session, true)],
    ["token changed", () => service.setAgentToken("claude", "new")],
    [
      "moved to another app",
      () =>
        void db
          .prepare("UPDATE agents SET app_id = 'codex' WHERE id = 'claude'")
          .run(),
    ],
  ] as [string, () => void][])(
    "hands nothing over when the request is no longer wanted: %s",
    async (_name, change) => {
      const started = start();
      const waiting = call(started);
      const asked = ask();
      change();
      const sending = watchers.send(asked);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await sending).toBe("refused");
      expect(row(started.id).state).not.toBe("used");
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await waiting).toEqual({ status: "wait" });
    },
  );

  it.each([
    ["the app", "app_id = 'codex'"],
    ["the agent", "agent_id = 'codex'"],
    ["the conversation", `conversation_id = '${OTHER}'`],
    ["the route", "route = 'queue'"],
  ])("hands nothing over when %s isn't the ticket's", async (_name, change) => {
    const started = start();
    const waiting = call(started);
    const asked = ask();
    db.prepare(`UPDATE rejoin_requests SET ${change}`).run();
    expect(await watchers.send(asked)).toBe("refused");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await waiting).toEqual({ status: "wait" });
    expect(row(started.id).state).toBe("live");
  });

  it("hands over nothing when the change can't be stored", async () => {
    const started = start();
    void call(started);
    const asked = ask();
    db.exec(
      "CREATE TRIGGER full BEFORE UPDATE OF request_id ON watchers BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await expect(watchers.send(asked)).rejects.toThrow("disk full");
    expect(row(started.id).state).toBe("live");
  });

  it("goes on after a stop of Konfab, without its file, and is never told twice", async () => {
    const started = start();
    void call(started);
    const { asked } = await click();
    // Konfab stops before the confirmation.
    service = create();
    watchers = createWatchers();
    service.recoverAfterRestart();
    watchers.tidy();
    expect(requests()).toEqual(["waiting?"]);
    expect(await call(started)).toEqual({ status: "rest" });
    expect(
      service.rejoin.rejoin("claude", asked.number, HERE, "watch"),
    ).toHaveProperty("session_id");
  });

  it("is live again after days without a call, and nothing was started instead", async () => {
    const started = start();
    void call(started);
    broken.at(-1)!.abort();
    for (let day = 0; day < 6; day += 1) {
      now += DAY;
      service = create();
      watchers = createWatchers();
      watchers.tidy();
      expect(watchers.offer("claude", "claude", HERE)).toEqual({
        running: true,
      });
      expect(view().offer).toBe("no_watcher");
    }
    void call(started);
    expect(view().offer).toBe("ready");
    expect(db.prepare("SELECT 1 FROM watchers").all()).toHaveLength(1);
  });

  it("ends after a week, when its app's token changes, it is archived or turned off", async () => {
    const ends = async (change: () => void) => {
      const started = start();
      void call(started);
      change();
      watchers.tidy();
      expect(row(started.id).state).toBe("ended");
      watchers.enabled = true;
      expect(await call(started)).toEqual({ status: "rest" });
      // So that the next one has a place.
      table.delete(started.pid);
    };
    await ends(() => void (now += 7 * DAY));
    await ends(() => service.setAgentToken("claude", "another"));
    await ends(() => void (watchers.enabled = false));
    await ends(
      () =>
        void db
          .prepare("UPDATE agents SET archived_at = 1 WHERE id = 'claude'")
          .run(),
    );
  });

  it("ends an open ticket that was turned off, at its next call", async () => {
    const started = start();
    void call(started);
    watchers.enabled = false;
    expect(await call(started)).toEqual({ status: "rest" });
    expect(row(started.id).state).toBe("ended");
  });

  describe("places", () => {
    const use = (started: Started) =>
      db
        .prepare("UPDATE watchers SET state = 'used' WHERE id = ?")
        .run(started.id);
    const fill = (count: number, conversation = HERE) =>
      Array.from({ length: count }, () => {
        const started = start(conversation);
        void call(started);
        use(started);
        return started;
      });

    it("are three for a conversation and six for an app", () => {
      fill(3);
      expect(watchers.offer("claude", "claude", HERE)).toBeUndefined();
      expect(view().offer).toBe("watchers_full");
      expect(view().resting).toBe(3);
      fill(3, OTHER);
      const third = "019a0000-0000-4000-8000-000000000003";
      expect(watchers.offer("claude", "claude", third)).toBeUndefined();
      expect(files()).toEqual([]);
    });

    it("are never freed by time, also when a watcher was stopped for months", async () => {
      const [first] = fill(3);
      for (let month = 0; month < 12; month += 1) {
        now += 30 * DAY;
        service = create();
        watchers = createWatchers();
        watchers.tidy();
        expect(watchers.offer("claude", "claude", HERE)).toBeUndefined();
      }
      expect(await call(first!)).toEqual({ status: "rest" });
      expect(
        db.prepare("SELECT 1 FROM watchers WHERE state <> 'gone'").all(),
      ).toHaveLength(3);
    });

    it.each([
      ["no process has the number", (s: Started) => void table.delete(s.pid)],
      [
        "another one has it",
        (s: Started) =>
          void table.set(s.pid, {
            state: "there",
            uid: process.getuid!(),
            start: "Tue Nov 24 11:00:00 2026",
            command: "vim",
          }),
      ],
      [
        "the same program has it again",
        (s: Started) =>
          void table.set(s.pid, {
            ...(table.get(s.pid) as Extract<Looked, object>),
            start: "Tue Nov 24 11:00:00 2026",
          }),
      ],
      ["the computer was started since", () => void (boot = "B")],
    ] as [string, (s: Started) => void][])(
      "are freed by proof: %s",
      async (_name, change) => {
        const [first] = fill(3);
        change(first!);
        expect(watchers.offer("claude", "claude", HERE)).toHaveProperty(
          "command",
        );
        // Its ticket is worth nothing any more.
        expect(row(first!.id)).toMatchObject({
          state: "gone",
          ticket_hash: null,
        });
        await expect(call(first!)).rejects.toThrow(RefusedWatch);
      },
    );

    it.each([
      ["can't be seen", (s: Started) => void table.set(s.pid, "unknown")],
      ["start unknown", () => void (boot = null)],
      [
        "stopped, but there",
        (s: Started) =>
          void table.set(s.pid, {
            ...(table.get(s.pid) as Extract<Looked, object>),
            command: "(node)",
          }),
      ],
      ["clock back", () => void (now -= 400 * DAY)],
      ["clock forward", () => void (now += 400 * DAY)],
    ] as [string, (s: Started) => void][])(
      "are kept while nothing is proven: %s",
      (_name, change) => {
        for (const started of fill(3)) change(started);
        expect(watchers.offer("claude", "claude", HERE)).toBeUndefined();
      },
    );

    it("of a live one that was killed is freed at the next join", () => {
      const started = start();
      void call(started);
      broken.at(-1)!.abort();
      table.delete(started.pid);
      expect(watchers.offer("claude", "claude", HERE)).toHaveProperty(
        "command",
      );
      expect(row(started.id).state).toBe("gone");
    });

    it("are given out at most twenty times a day", () => {
      for (let i = 0; i < 20; i += 1) {
        const started = start();
        void call(started);
        use(started);
        table.delete(started.pid);
      }
      expect(watchers.offer("claude", "claude", HERE)).toBeUndefined();
      now += DAY;
      expect(watchers.offer("claude", "claude", HERE)).toHaveProperty(
        "command",
      );
    });
  });

  describe("cleaning up", () => {
    const openWait = () => {
      const joined = service.join("claude", ROOM, HERE, "watch").session_id;
      service.beginObservedWait("claude", joined, "c1");
      service.poll("claude", joined, true);
      return joined;
    };
    const used = () => {
      const started = start();
      void call(started);
      db.prepare("UPDATE watchers SET state = 'used' WHERE id = ?").run(
        started.id,
      );
      return started;
    };

    it("tells one to leave only while its own agent is waiting there", async () => {
      const started = used();
      expect(await call(started)).toEqual({ status: "rest" });
      // Waiting in another conversation isn't it.
      const there = service.join("claude", ROOM, OTHER, "watch").session_id;
      service.beginObservedWait("claude", there, "c0");
      service.poll("claude", there, true);
      expect(await call(started)).toEqual({ status: "rest" });
      const joined = openWait();
      expect(await call(started)).toEqual({ status: "leave" });
      // The answer may have been lost.
      expect(await call(started)).toEqual({ status: "leave" });
      service.finishObservedWait("claude", joined, "c1");
      expect(await call(used())).toEqual({ status: "rest" });
    });

    it("leaves a wait that has gone quiet alone", async () => {
      openWait();
      const started = used();
      now += 31_000;
      expect(await call(started)).toEqual({ status: "rest" });
    });

    it("is one at a time, and at most two a day", async () => {
      const all = [used(), used(), used()];
      const joined = openWait();
      const keep = (ms: number) => {
        now += ms;
        service.poll("claude", joined, false);
      };
      expect(await call(all[0]!)).toEqual({ status: "leave" });
      expect(await call(all[1]!)).toEqual({ status: "rest" });
      keep(60_001);
      expect(await call(all[1]!)).toEqual({ status: "leave" });
      keep(60_001);
      expect(await call(all[2]!)).toEqual({ status: "rest" });
    });

    it("is off after a join soon after it: it may have woken the conversation", async () => {
      const all = [used(), used()];
      openWait();
      expect(await call(all[0]!)).toEqual({ status: "leave" });
      now += 30_000;
      watchers.offer("claude", "claude", HERE);
      openWait();
      now += 2 * DAY;
      openWait();
      expect(await call(all[1]!)).toEqual({ status: "rest" });
    });
  });

  it("shows nothing while it is off, and asks for a new join after it was turned on", () => {
    service.rejoin.watchers = null;
    expect(view().offer).toBeNull();
    service.join("claude", ROOM);
    away();
    service = create();
    watchers = createWatchers();
    expect(view()).toMatchObject({ app: "claude", offer: "old_join" });
    service.join("claude", ROOM, HERE, "watch");
    expect(view().offer).toBe("connected");
    // The other app's command has nothing to do with it.
    service.rejoin.available = () => true;
    away();
    expect(view().offer).toBe("no_watcher");
    expect(() => ask()).toThrow(/can't be asked/);
  });

  it("keeps the two routes apart", async () => {
    service.rejoin.available = () => true;
    const started = start();
    void call(started);
    const { asked } = await click();
    expect(service.rejoin.rejoin("claude", asked.number, HERE)).toMatchObject({
      status: "closed",
    });
    expect(
      service.rejoin.rejoin("claude", asked.number, HERE, "watch"),
    ).toHaveProperty("session_id");
  });

  it("puts the advance word into the prompts only for agents that use it", () => {
    const word = /start exactly that command once, in the background/;
    expect(service.joinPrompt(ROOM, "claude")).toMatch(word);
    expect(service.rejoinPrompt(ROOM, "claude")).toMatch(word);
    expect(service.joinPrompt(ROOM, "codex")).not.toMatch(word);
    const on = service.joinPrompt(ROOM, "claude");
    service.rejoin.watchers = null;
    expect(service.joinPrompt(ROOM, "claude")).not.toMatch(word);
    expect(on.startsWith(service.joinPrompt(ROOM, "claude"))).toBe(true);
  });
});

describe("looking at processes", () => {
  const line =
    " 4242   501 Mon Nov 23 16:35:34 2026     node /a b/watch.js /c/7\n";
  const look = (answer: ReturnType<Run>, pid = 4242) =>
    macProcesses(() => answer).look(pid);

  it("reads one", () => {
    expect(look({ code: 0, out: line, err: "" })).toEqual({
      state: "there",
      uid: 501,
      start: "Mon Nov 23 16:35:34 2026",
      command: "node /a b/watch.js /c/7",
    });
    expect(look({ code: 1, out: "", err: "" })).toBe("none");
  });

  it.each([
    ["failed", { code: null, out: "", err: "failed" }],
    ["an error", { code: 1, out: "", err: "ps: no" }],
    ["another code", { code: 2, out: "", err: "" }],
    ["a warning", { code: 0, out: line, err: "odd" }],
    ["nonsense", { code: 0, out: "nonsense\n", err: "" }],
    ["nothing", { code: 0, out: "", err: "" }],
    ["two", { code: 0, out: line + line, err: "" }],
    ["another's", { code: 0, out: line.replace("4242", "4243"), err: "" }],
  ] as [string, ReturnType<Run>][])(
    "concludes nothing from %s",
    (_name, answer) => {
      expect(look(answer)).toBe("unknown");
    },
  );

  it("looks at no odd number, and starts nothing for it", () => {
    let ran = 0;
    const processes = macProcesses(() => {
      ran += 1;
      return { code: 1, out: "", err: "" };
    });
    for (const pid of [-1, 0, 1, 1.5, NaN, Infinity])
      expect(processes.look(pid)).toBe("unknown");
    expect(ran).toBe(0);
  });

  it("reads the computer's start, or nothing", () => {
    const boot = (answer: ReturnType<Run>) => macProcesses(() => answer).boot();
    const id = "0F9A2D6E-1111-4222-8333-444455556666";
    expect(boot({ code: 0, out: `${id}\n`, err: "" })).toBe(id);
    for (const out of ["", "0", `${id}${id}`])
      expect(boot({ code: 0, out, err: "" })).toBeNull();
    expect(boot({ code: 1, out: id, err: "" })).toBeNull();
    expect(boot({ code: 0, out: id, err: "odd" })).toBeNull();
  });

  it.runIf(process.platform === "darwin")("works on this computer", () => {
    const mine = macProcesses().look(process.pid);
    expect(mine).toMatchObject({ state: "there", uid: process.getuid!() });
    expect(macProcesses().look(process.pid)).toEqual(mine);
    expect(macProcesses().boot()).toMatch(/^[0-9A-F-]{36}$/i);
    expect(macProcesses().boot()).toBe(macProcesses().boot());
  });
});
