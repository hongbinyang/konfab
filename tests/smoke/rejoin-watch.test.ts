import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createProbe, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "dist/cli/watch.js");
const TICKET = `kfw_${"a".repeat(27)}`;
const HERE = "019a0000-0000-4000-8000-000000000001";
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Started = {
  child: ChildProcess;
  out: () => string;
  ended: Promise<number | null>;
};
const running: ChildProcess[] = [];
/** As an app starts a background command: by a shell that stays above it. */
const startCommand = (command: string): Started => {
  const child = spawn("/bin/sh", ["-c", `${command}; exit $?`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  return {
    child,
    out: () => out,
    ended: new Promise((done) => child.once("close", (code) => done(code))),
  };
};
const below = (pid: number): number =>
  Number(
    spawnSync("/usr/bin/pgrep", ["-P", String(pid)], {
      encoding: "utf8",
    }).stdout.trim(),
  );
const ended = async (started: Started, ms: number) =>
  Promise.race([started.ended, pause(ms).then(() => "running" as const)]);

// Only macOS is offered.
describe.runIf(process.platform === "darwin")("the watcher command", () => {
  let root: string;
  let server: Server;
  let port: number;
  let calls: { path: string; body: string; ticket: string }[];
  let answer: RequestListener;

  const ticketFile = (text = JSON.stringify({ ticket: TICKET, port })) => {
    const path = join(root, "7");
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };
  const watch = (path: string) =>
    startCommand(`'${process.execPath}' '${SCRIPT}' '${path}'`);
  const json =
    (value: unknown, code = 200): RequestListener =>
    (_request, response) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
  const hold: RequestListener = () => {};

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "konfab-watch-")));
    calls = [];
    answer = hold;
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        calls.push({
          path: request.url ?? "",
          body,
          ticket: request.headers.authorization ?? "",
        });
        answer(request, response);
      });
    });
    await new Promise<void>((done) =>
      server.listen(0, "127.0.0.1", () => done()),
    );
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const child of running.splice(0)) {
      const inner = child.pid ? below(child.pid) : 0;
      if (inner) spawnSync("/bin/kill", ["-9", String(inner)]);
      child.kill("SIGKILL");
    }
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    rmSync(root, { recursive: true, force: true });
  });

  it("is silent while it waits, and prints one line and confirms it for a request", async () => {
    let round = 0;
    answer = (request, response) => {
      if (request.url === "/agent/watch/printed")
        return json({ ok: true })(request, response);
      round += 1;
      if (round < 4) return json({ status: "wait" })(request, response);
      setTimeout(
        () =>
          json({
            status: "print",
            request: "A".repeat(26),
            handover: "h1",
          })(request, response),
        1000,
      );
    };
    const started = watch(ticketFile());
    await pause(800);
    expect(started.out()).toBe("");
    expect(await ended(started, 5000)).toBe(0);
    expect(started.out()).toBe(
      `Konfab: the lead asked you to rejoin. request "${"A".repeat(26)}"\n`,
    );
    expect(calls.at(-1)).toEqual({
      path: "/agent/watch/printed",
      body: JSON.stringify({ handover: "h1" }),
      ticket: `Bearer ${TICKET}`,
    });
    expect(
      calls.filter((call) => call.path === "/agent/watch/printed"),
    ).toHaveLength(1);
  });

  it("doesn't confirm, or print again, when its output can't be written", async () => {
    answer = json({
      status: "print",
      request: "A".repeat(26),
      handover: "h1",
    });
    const path = ticketFile();
    const child = spawn(process.execPath, [SCRIPT, path], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    running.push(child);
    child.stdout.destroy();
    const code = await new Promise((done) => child.once("exit", done));
    expect(code).toBe(3);
    expect(calls.map((call) => call.path)).toEqual(["/agent/watch"]);
  });

  it("repeats a lost confirmation, and nothing else", async () => {
    let lost = 0;
    answer = (request, response) => {
      if (request.url !== "/agent/watch/printed")
        return json({
          status: "print",
          request: "A".repeat(26),
          handover: "h1",
        })(request, response);
      lost += 1;
      if (lost < 3) return void response.destroy();
      json({ ok: true })(request, response);
    };
    const started = watch(ticketFile());
    expect(await ended(started, 8000)).toBe(0);
    expect(started.out().split("\n")).toHaveLength(2);
    expect(calls.filter((call) => call.path === "/agent/watch")).toHaveLength(
      1,
    );
    expect(lost).toBe(3);
  });

  it("rests without calling often, and leaves with one line that has no request", async () => {
    let rested = false;
    answer = (request, response) => {
      const value = rested ? { status: "leave" } : { status: "rest" };
      rested = true;
      json(value)(request, response);
    };
    const started = watch(ticketFile());
    expect(await ended(started, 5000)).toBe("running");
    expect(calls).toHaveLength(1);
    expect(started.out()).toBe("");
    rested = true;
    // At the start, "leave" ends it at once.
    const second = watch(ticketFile());
    expect(await ended(second, 5000)).toBe(0);
    expect(second.out()).toBe("Konfab watcher ended; nothing to do.\n");
  });

  it.each([
    ["refused", json({ code: "unauthorized" }, 401)],
    ["not Konfab", json({ hello: 1 })],
    ["a list", json([])],
    [
      "a redirect",
      (_request, response) => {
        response.writeHead(302, { location: "http://example.com/" });
        response.end("{}");
      },
    ],
    [
      "a request that isn't one",
      json({ status: "print", request: "x; rm -rf /", handover: "h" }),
    ],
    [
      "a request without a handover",
      json({ status: "print", request: "A".repeat(26) }),
    ],
  ] as [string, RequestListener][])(
    "ends at once, saying why, when it isn't accepted at its start: %s",
    async (_name, how) => {
      answer = how;
      const started = watch(ticketFile());
      expect(await ended(started, 6000)).toBe(1);
      expect(started.out()).toMatch(
        /^Konfab watcher: [^\n]+\. There is no request; start nothing\.\n$/,
      );
      expect(started.out()).not.toContain("rm -rf");
      expect(calls.every((call) => call.path === "/agent/watch")).toBe(true);
    },
  );

  it.each([
    ["nobody there", () => void server.close()],
    [
      "endless",
      () =>
        void (answer = (_request, response) => {
          response.writeHead(200);
          const timer = setInterval(() => response.write("x".repeat(500)), 5);
          response.on("close", () => clearInterval(timer));
        }),
    ],
    [
      "broken off",
      () => void (answer = (_request, response) => void response.destroy()),
    ],
    [
      "not JSON",
      () => void (answer = (_request, response) => void response.end("<html>")),
    ],
  ] as [string, () => void][])(
    "ends after ten seconds when there is no answer at its start: %s",
    async (_name, prepare) => {
      prepare();
      const started = watch(ticketFile());
      expect(await ended(started, 3000)).toBe("running");
      expect(await ended(started, 25_000)).toBe(1);
      expect(started.out()).toContain("didn't accept it");
    },
    40_000,
  );

  it("goes on silently when Konfab stops and comes back", async () => {
    answer = json({ status: "wait" });
    let round = 0;
    const real = answer;
    answer = (request, response) => {
      round += 1;
      if (round === 1) return real(request, response);
      if (round < 4) return void response.destroy();
      if (request.url === "/agent/watch/printed")
        return json({ ok: true })(request, response);
      json({ status: "print", request: "B".repeat(26), handover: "h" })(
        request,
        response,
      );
    };
    const started = watch(ticketFile());
    expect(await ended(started, 15_000)).toBe(0);
    expect(started.out()).toContain("B".repeat(26));
  }, 20_000);

  it.each([
    ["missing", (path: string) => rmSync(path)],
    ["open to others", (path: string) => chmodSync(path, 0o644)],
    [
      "a link",
      (path: string) => {
        writeFileSync(`${path}x`, readFileSync(path), { mode: 0o600 });
        rmSync(path);
        symlinkSync(`${path}x`, path);
      },
    ],
    ["there twice", (path: string) => linkSync(path, `${path}y`)],
    ["not JSON", (path: string) => writeFileSync(path, "x")],
    [
      "for another place",
      (path: string) =>
        writeFileSync(path, JSON.stringify({ ticket: TICKET, port: "80@x" })),
    ],
    [
      "another kind of ticket",
      (path: string) =>
        writeFileSync(path, JSON.stringify({ ticket: "kfb_x", port })),
    ],
    ["too long", (path: string) => writeFileSync(path, " ".repeat(2000))],
  ] as [string, (path: string) => void][])(
    "calls nobody when its ticket is %s",
    async (_name, change) => {
      const path = ticketFile();
      change(path);
      const started = watch(path);
      expect(await ended(started, 5000)).toBe(1);
      expect(started.out()).toMatch(/start nothing\.\n$/);
      expect(calls).toEqual([]);
    },
  );

  it("starts nothing without exactly one ticket", async () => {
    for (const command of ["", " a b"]) {
      const started = startCommand(
        `'${process.execPath}' '${SCRIPT}'${command}`,
      );
      expect(await ended(started, 5000)).toBe(1);
      expect(started.out()).toContain("without a ticket");
    }
  });

  it("ends silently when a process above it is gone", async () => {
    const started = watch(ticketFile());
    await pause(1500);
    expect(calls).toHaveLength(1);
    const inner = below(started.child.pid!);
    expect(inner).toBeGreaterThan(1);
    started.child.kill("SIGKILL");
    const there = () =>
      spawnSync("/bin/ps", ["-o", "pid=", "-p", String(inner)], {
        encoding: "utf8",
      }).stdout.trim() !== "";
    expect(there()).toBe(true);
    await expect.poll(there, { timeout: 45_000, interval: 1000 }).toBe(false);
    expect(started.out()).toBe("");
  }, 60_000);
});

describe.runIf(process.platform === "darwin")(
  "a watcher with the real server and connector",
  () => {
    let home: string;
    let url: string;
    let env: NodeJS.ProcessEnv;
    let server: ChildProcess;
    let client: Client;
    let cookie: string;
    let roomId: number;
    let db: InstanceType<typeof Database>;

    const startServer = async (signal?: NodeJS.Signals) => {
      if (signal) {
        const gone = new Promise((done) => server.once("exit", done));
        server.kill(signal);
        await gone;
      }
      server = spawn(process.execPath, ["dist/server/index.js"], {
        cwd: ROOT,
        env,
        stdio: "ignore",
      });
      for (let i = 0; i < 100; i += 1) {
        try {
          await fetch(url);
          return;
        } catch {
          await pause(100);
        }
      }
      throw new Error("Server did not start");
    };
    const cli = (script: string) =>
      spawnSync(process.execPath, [script], {
        cwd: ROOT,
        env,
        encoding: "utf8",
      }).stdout;
    const page = (path: string, method = "GET", body?: object) =>
      fetch(`${url}${path}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      if (result.isError) throw new Error(result.content[0]!.text);
      return JSON.parse(result.content[0]!.text);
    };
    const card = async () =>
      (
        (await (await page(`/api/rooms/${roomId}`)).json()) as {
          agents: {
            id: string;
            rejoin: {
              offer: string | null;
              request: { state: string; unsure: boolean } | null;
            };
          }[];
        }
      ).agents.find((agent) => agent.id === "claude")!.rejoin;
    const click = () =>
      page(`/api/rooms/${roomId}/agents/claude/rejoin`, "POST", {});
    /** As if its conversation had ended a while ago. */
    const stop = (session: string) =>
      db
        .prepare(
          "UPDATE sessions SET state = 'ended', end_reason = 'run_window_ended' WHERE id = ?",
        )
        .run(session);
    const numberIn = (text: string) =>
      /request "([A-Z0-9]{26})"/.exec(text)?.[1];
    const requests = () =>
      db.prepare("SELECT state, unsure FROM rejoin_requests ORDER BY id").all();

    beforeEach(async () => {
      home = mkdtempSync(join(tmpdir(), "konfab-watched-"));
      const probe = createProbe();
      await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
      const port = (probe.address() as AddressInfo).port;
      await new Promise((done) => probe.close(done));
      url = `http://127.0.0.1:${port}`;
      env = { ...process.env, KONFAB_HOME: home };
      delete env.KONFAB_ISOLATED;
      writeFileSync(
        join(home, "config.yaml"),
        `server:\n  port: ${port}\n  tick_seconds: 1\nconnectors:\n  install: manual\ndefaults:\n  wait_timeout_seconds: 2\nrejoin:\n  codex_command: ${JSON.stringify(join(home, "none"))}\n  claude_watcher: true\n`,
        { mode: 0o600 },
      );
      cli("dist/cli/setup.js");
      const token = /kfb_[\w-]+/.exec(
        readFileSync(join(home, "app-setup.md"), "utf8"),
      )![0];
      await startServer();
      const login = await fetch(cli("dist/cli/login-link.js").trim(), {
        redirect: "manual",
      });
      cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
      roomId = (
        (await (
          await page("/api/rooms", "POST", {
            name: "watched",
            topic: "",
            members: ["claude", "codex"],
          })
        ).json()) as { id: number }
      ).id;
      client = new Client({ name: "claude-code", version: "1.0.0" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [join(ROOT, "dist/bridge/index.js")],
          env: {
            KONFAB_URL: url,
            KONFAB_TOKEN: token,
            CLAUDE_CODE_SESSION_ID: HERE,
          },
        }),
      );
      db = new Database(join(home, "konfab.db"), { timeout: 5000 });
    });
    afterEach(async () => {
      for (const child of running.splice(0)) {
        const inner = child.pid ? below(child.pid) : 0;
        if (inner) spawnSync("/bin/kill", ["-9", String(inner)]);
        child.kill("SIGKILL");
      }
      await client.close();
      db.close();
      const gone = new Promise((done) => server.once("exit", done));
      server.kill("SIGTERM");
      await gone;
      rmSync(home, { recursive: true, force: true });
    });

    it("brings the agent back on the lead's click, once, and gives a new watcher", async () => {
      const joined = await tool("join_room", { room: "watched" });
      const { command, instructions } = joined.watcher;
      expect(instructions).toContain("in the background");
      const [file] = readdirSync(join(home, "watch"));
      const { ticket } = JSON.parse(
        readFileSync(join(home, "watch", file!), "utf8"),
      );
      const started = startCommand(command);
      stop(joined.session_id);
      await expect
        .poll(async () => (await card()).offer, { timeout: 5000 })
        .toBe("ready");
      expect(readdirSync(join(home, "watch"))).toEqual([]);
      const processes = spawnSync("/bin/ps", ["-axwwo", "command="], {
        encoding: "utf8",
      }).stdout;
      expect(processes).toContain(SCRIPT);
      expect(processes).not.toContain(ticket);

      // Started again: one line, and it ends in the same turn.
      const second = startCommand(command);
      expect(await ended(second, 5000)).toBe(1);
      expect(second.out()).toContain("its ticket isn't there");

      expect((await click()).status).toBe(200);
      expect(await ended(started, 5000)).toBe(0);
      expect(requests()).toEqual([{ state: "waiting", unsure: 0 }]);
      const number = numberIn(started.out());
      const back = await tool("rejoin_room", { request: number });
      expect(back.room).toBe("watched");
      expect(back.watcher.command).not.toBe(command);
      expect((await card()).request).toMatchObject({ state: "joined" });
      await tool("wait_for_turn", { session_id: back.session_id });
      expect(requests()).toEqual([{ state: "back", unsure: 0 }]);
      expect(
        db.prepare("SELECT 1 FROM sessions WHERE agent_id = 'claude'").all(),
      ).toHaveLength(2);

      const shown = [
        await (await page(`/api/rooms/${roomId}`)).text(),
        await (await page("/api/overview")).text(),
        readFileSync(join(home, "logs/konfab.log"), "utf8"),
        JSON.stringify(
          (
            db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
              .all() as { name: string }[]
          ).map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all()),
        ),
      ];
      expect(shown[2]).toContain("/agent/rejoin");
      for (const text of shown) {
        expect(text).not.toContain(ticket);
        expect(text).not.toContain(number);
      }
      expect(shown[0]).not.toContain(HERE);
      expect(shown[2]).not.toContain(HERE);
    }, 40_000);

    it("goes on through a kill of Konfab, and isn't told twice", async () => {
      const joined = await tool("join_room", { room: "watched" });
      const started = startCommand(joined.watcher.command);
      stop(joined.session_id);
      await expect
        .poll(async () => (await card()).offer, { timeout: 5000 })
        .toBe("ready");
      await startServer("SIGKILL");
      await expect
        .poll(async () => (await card()).offer, { timeout: 20_000 })
        .toBe("ready");
      const inner = below(started.child.pid!);
      spawnSync("/bin/kill", ["-STOP", String(inner)]);
      const sending = click().catch(() => undefined);
      await expect
        .poll(() => db.prepare("SELECT state FROM watchers").all())
        .toEqual([{ state: "used" }]);
      // Handed over, not printed: Konfab is killed, then it goes on.
      await startServer("SIGKILL");
      await sending;
      expect(requests()).toEqual([{ state: "waiting", unsure: 1 }]);
      spawnSync("/bin/kill", ["-CONT", String(inner)]);
      await ended(started, 15_000);
      const number = numberIn(started.out());
      if (number) {
        // It had the answer already: the number works once, for this one.
        expect(await ended(started, 15_000)).toBe(0);
        expect(await tool("rejoin_room", { request: number })).toHaveProperty(
          "session_id",
        );
      } else
        expect(db.prepare("SELECT state FROM watchers").all()).toEqual([
          { state: "used" },
        ]);
      expect(db.prepare("SELECT 1 FROM rejoin_requests").all()).toHaveLength(1);
    }, 60_000);

    it("keeps the place of one that is stopped, and frees that of one that was killed", async () => {
      const joined = await tool("join_room", { room: "watched" });
      const started = startCommand(joined.watcher.command);
      stop(joined.session_id);
      await expect
        .poll(async () => (await card()).offer, { timeout: 5000 })
        .toBe("ready");
      const inner = below(started.child.pid!);
      spawnSync("/bin/kill", ["-STOP", String(inner)]);
      await startServer("SIGKILL");
      expect((await tool("join_room", { room: "watched" })).watcher).toEqual({
        running: true,
      });
      spawnSync("/bin/kill", ["-CONT", String(inner)]);
      const second = await tool("join_room", { room: "watched" });
      stop(second.session_id);
      await expect
        .poll(async () => (await card()).offer, { timeout: 30_000 })
        .toBe("ready");
      spawnSync("/bin/kill", ["-9", String(inner)]);
      await started.ended;
      expect(
        (await tool("join_room", { room: "watched" })).watcher,
      ).toHaveProperty("command");
      expect(
        db.prepare("SELECT state FROM watchers ORDER BY id").all(),
      ).toEqual([{ state: "gone" }, { state: "issued" }]);
    }, 60_000);

    it("ends one that was stopped before its first call, when its ticket is gone", async () => {
      const joined = await tool("join_room", { room: "watched" });
      const path = /'([^']+)'$/.exec(joined.watcher.command)![1]!;
      // It has read its ticket and is stopped before it calls: the stand-in
      // for that moment is a server that doesn't answer.
      spawnSync("/bin/kill", ["-STOP", String(server.pid)]);
      const started = startCommand(joined.watcher.command);
      await pause(1500);
      const inner = below(started.child.pid!);
      spawnSync("/bin/kill", ["-STOP", String(inner)]);
      server.kill("SIGKILL");
      db.prepare("UPDATE watchers SET created_at = created_at - 200000").run();
      await startServer();
      await expect.poll(() => existsSync(path), { timeout: 5000 }).toBe(false);
      spawnSync("/bin/kill", ["-CONT", String(inner)]);
      expect(await ended(started, 20_000)).toBe(1);
      expect(started.out()).toContain("didn't accept it");
      expect(db.prepare("SELECT state, pid FROM watchers").all()).toEqual([
        { state: "gone", pid: null },
      ]);
    }, 60_000);

    it("accepts a ticket nowhere else, and the connector's token not here", async () => {
      const joined = await tool("join_room", { room: "watched" });
      const path = /'([^']+)'$/.exec(joined.watcher.command)![1]!;
      const { ticket } = JSON.parse(readFileSync(path, "utf8"));
      const post = (route: string, bearer: string, body: object) =>
        fetch(`${url}${route}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      for (const route of [
        "/agent/join",
        "/agent/rejoin",
        "/agent/wait",
        "/agent/post",
        "/agent/watchx",
        "/agent/watch/other",
      ])
        expect(
          (await post(route, ticket, { room: "watched", pid: 1 })).status,
          route,
        ).toBe(401);
      expect((await page(`/api/rooms/${roomId}`)).status).toBe(200);
      const noCookie = await fetch(`${url}/api/rooms/${roomId}`, {
        headers: { authorization: `Bearer ${ticket}` },
      });
      expect(noCookie.status).toBe(401);
      const token = /kfb_[\w-]+/.exec(
        readFileSync(join(home, "app-setup.md"), "utf8"),
      )![0];
      for (const bearer of [token, "x"]) {
        expect((await post("/agent/watch", bearer, { pid: 1 })).status).toBe(
          401,
        );
        expect(
          (await post("/agent/watch/printed", bearer, { handover: "x" }))
            .status,
        ).toBe(401);
      }
      // This process has the ticket, but isn't a watcher.
      expect(
        (await post("/agent/watch", ticket, { pid: process.pid })).status,
      ).toBe(401);
      expect((await post("/agent/watch", ticket, { pid: "x" })).status).toBe(
        400,
      );
      expect(
        (await post("/agent/watch", ticket, { pid: 1, more: "x".repeat(2000) }))
          .status,
      ).toBe(413);
      const foreign = await fetch(`${url}/agent/watch`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ticket}`,
          origin: "http://evil.example",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(foreign.status).toBe(403);
      expect(db.prepare("SELECT state FROM watchers").all()).toEqual([
        { state: "issued" },
      ]);
    }, 30_000);
  },
);
