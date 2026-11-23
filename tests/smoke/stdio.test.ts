import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const WAIT_SECONDS = 2;
const ROOM = "test";

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

interface RoomState {
  messages: { id: number; body: string }[];
  agents: { id: string; state: string }[];
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

describe("built app over real processes", () => {
  let home: string;
  let url: string;
  let env: NodeJS.ProcessEnv;
  let server: ChildProcess | undefined;
  let tokens: string[];
  let clients: Client[];
  let cookie: string;
  let roomId: number;

  const runCli = (script: string, args: string[] = []): Promise<string> =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
      child.on("close", (code) =>
        code === 0
          ? done(output)
          : fail(new Error(`${script} exited with ${code}: ${errors}`)),
      );
    });

  const startServer = async (): Promise<ChildProcess> => {
    const child = spawn(process.execPath, ["dist/server/index.js"], {
      cwd: ROOT,
      env,
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await fetch(`${url}/`);
        return child;
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    child.kill("SIGKILL");
    throw new Error("Server did not start");
  };

  const stopServer = (child: ChildProcess): Promise<void> =>
    new Promise((done) => {
      if (child.exitCode !== null) return done();
      child.once("exit", () => done());
      child.kill("SIGTERM");
    });

  const connect = async (token: string): Promise<Client> => {
    const client = new Client({ name: "smoke", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "dist/bridge/index.js")],
        env: { KONFAB_URL: url, KONFAB_TOKEN: token },
      }),
    );
    clients.push(client);
    return client;
  };

  const tool = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> => {
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as ToolResult;
    if (result.isError) throw new Error(result.content[0]?.text);
    return JSON.parse(result.content[0]?.text ?? "null");
  };

  const page = (path: string, options: RequestInit = {}): Promise<Response> =>
    fetch(`${url}${path}`, {
      ...options,
      headers: {
        cookie,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

  const userPost = (body: string): Promise<Response> =>
    page(`/api/rooms/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });

  const roomState = async (): Promise<RoomState> =>
    (await (await page(`/api/rooms/${roomId}`)).json()) as RoomState;

  beforeEach(async () => {
    clients = [];
    server = undefined;
    home = mkdtempSync(join(tmpdir(), "konfab-smoke-"));
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    env = { ...process.env, KONFAB_HOME: home };
    writeFileSync(
      join(home, "config.yaml"),
      [
        `server:\n  port: ${port}\n  tick_seconds: 1`,
        "connectors:\n  install: manual",
        "defaults:",
        `  wait_timeout_seconds: ${WAIT_SECONDS}`,
        "  auto_continue_delay_seconds: 10",
        '  hours: { start: "00:00", end: "00:00", days: [sun, mon, tue, wed, thu, fri, sat] }',
      ].join("\n"),
      { mode: 0o600 },
    );
    await runCli("dist/cli/setup.js");
    const setup = readFileSync(join(home, "app-setup.md"), "utf8");
    tokens = [...setup.matchAll(/kfb_[\w-]+/g)].map((match) => match[0]);
    server = await startServer();

    const link = (await runCli("dist/cli/login-link.js")).trim();
    const login = await fetch(link, { redirect: "manual" });
    expect(login.status).toBe(303);
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const created = await page("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: ROOM,
        topic: "Smoke test",
        members: ["claude", "codex"],
      }),
    });
    expect(created.status).toBe(201);
    roomId = ((await created.json()) as { id: number }).id;
  });

  afterEach(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    if (server) await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  });

  it("recovers self, watchdog and timeout continuations across real processes", async () => {
    const agent = await connect(tokens[0] ?? "");
    const session = (await tool(agent, "join_room", { room: ROOM })).session_id;
    await userPost("@claude start");
    let turn = await tool(agent, "wait_for_turn", { session_id: session });
    const posted = await tool(agent, "post_message", {
      session_id: session,
      turn_id: turn.turn_id,
      body: "Continuing",
      next: { kind: "self" },
    });
    turn = await tool(agent, "wait_for_turn", { session_id: session });
    expect(turn.continuation).toMatchObject({
      reason: "self",
      source_message_id: posted.message_id,
    });
    const legacy = await tool(agent, "post_message", {
      session_id: session,
      turn_id: turn.turn_id,
      body: "Still working",
    });
    await stopServer(server!);
    server = undefined;
    let db = new Database(join(home, "konfab.db"));
    db.prepare(
      "UPDATE automatic_continuations SET due_at = ? WHERE state = 'pending'",
    ).run(Date.now() - 1);
    db.close();
    server = await startServer();
    const deadline = Date.now() + 8000;
    do {
      turn = await tool(agent, "wait_for_turn", { session_id: session });
    } while (turn.status === "idle" && Date.now() < deadline);
    expect(turn.continuation).toMatchObject({
      reason: "watchdog",
      source_message_id: legacy.message_id,
    });
    db = new Database(join(home, "konfab.db"));
    db.prepare(
      "UPDATE turns SET started_at = ?, last_progress_at = NULL WHERE id = ?",
    ).run(Date.now() - 31 * 60_000, turn.turn_id);
    db.close();
    const timeoutDeadline = Date.now() + 5000;
    do {
      await new Promise((done) => setTimeout(done, 200));
      db = new Database(join(home, "konfab.db"));
      const row = db
        .prepare("SELECT state FROM turns WHERE id = ?")
        .get(turn.turn_id) as { state: string };
      db.close();
      if (row.state === "skipped") break;
    } while (Date.now() < timeoutDeadline);
    const recovered = await tool(agent, "wait_for_turn", {
      session_id: session,
    });
    expect(recovered.continuation?.reason).toBe("timeout_recovery");
    await tool(agent, "post_message", {
      session_id: session,
      turn_id: recovered.turn_id,
      body: "Finished",
      next: { kind: "done" },
    });
    const done = await roomState();
    expect(done.messages.at(-1)?.body).toBe("Finished");
  });

  it("runs a conversation, survives a restart, and keeps clean history", async () => {
    expect(tokens).toHaveLength(2);
    const claude = await connect(tokens[0] ?? "");
    const codex = await connect(tokens[1] ?? "");
    const a = (await tool(claude, "join_room", { room: ROOM })).session_id;
    const b = (await tool(codex, "join_room", { room: ROOM })).session_id;

    const started = Date.now();
    const idle = await tool(claude, "wait_for_turn", { session_id: a });
    expect(idle.status).toBe("idle");
    expect(Date.now() - started).toBeLessThan((WAIT_SECONDS + 2) * 1000);

    const waitA = tool(claude, "wait_for_turn", { session_id: a });
    const waitB = tool(codex, "wait_for_turn", { session_id: b });
    await userPost("@claude ask @codex something");
    const turnA = await waitA;
    expect(turnA.status).toBe("turn");

    await tool(claude, "post_message", {
      session_id: a,
      turn_id: turnA.turn_id,
      body: "@codex what next?",
    });
    const turnB = await waitB;
    expect(turnB.status).toBe("turn");
    expect(turnB.messages.at(-1).body).toBe("@codex what next?");
    await tool(codex, "post_message", {
      session_id: b,
      turn_id: turnB.turn_id,
      body: "Ship it",
    });

    const duringRestart = tool(claude, "wait_for_turn", { session_id: a });
    await stopServer(server as ChildProcess);
    server = await startServer();
    expect((await duringRestart).status).toBe("idle");

    const waitAgain = tool(claude, "wait_for_turn", { session_id: a });
    await userPost("@claude after restart");
    const resumed = await waitAgain;
    expect(resumed.messages.map((m: { body: string }) => m.body)).toEqual([
      "Ship it",
      "@claude after restart",
    ]);
    await tool(claude, "pass_turn", {
      session_id: a,
      turn_id: resumed.turn_id,
    });

    const state = await roomState();
    expect(state.messages.map((message) => message.body)).toEqual([
      "@claude ask @codex something",
      "@codex what next?",
      "Ship it",
      "@claude after restart",
    ]);
    expect(state.agents.map((agent) => agent.state)).toEqual([
      "waiting",
      "waiting",
    ]);
  });

  it("runs the permission flow from agent to page", async () => {
    const claude = await connect(tokens[0] ?? "");
    const session = (await tool(claude, "join_room", { room: ROOM }))
      .session_id;
    const pending = tool(claude, "request_permission", {
      session_id: session,
      recipient: "example.com",
      data_description: "A log file",
      reason: "To debug",
    });

    let requestId: number | undefined;
    for (let attempt = 0; attempt < 50 && !requestId; attempt += 1) {
      const overview = (await (await page("/api/overview")).json()) as {
        permissions: { id: number }[];
      };
      requestId = overview.permissions[0]?.id;
      if (!requestId) await new Promise((done) => setTimeout(done, 100));
    }
    expect(requestId).toBeDefined();

    await page(`/api/permissions/${requestId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved" }),
    });
    expect((await pending).state).toBe("approved");
  });

  it("stops a waiting agent for a break, and rejoining ends it", async () => {
    const claude = await connect(tokens[0] ?? "");
    const first = (await tool(claude, "join_room", { room: ROOM })).session_id;
    const waiting = tool(claude, "wait_for_turn", { session_id: first });
    const started = await page(`/api/rooms/${roomId}/break`, {
      method: "POST",
      body: "{}",
    });
    expect(started.status).toBe(200);
    expect(await waiting).toMatchObject({
      status: "closed",
      reason: "on_break",
    });

    await userPost("While you were away");
    const second = (await tool(claude, "join_room", { room: ROOM })).session_id;
    const turn = await tool(claude, "wait_for_turn", { session_id: second });
    expect(turn.status).toBe("turn");
    expect(turn.messages.at(-1).body).toBe("While you were away");
  });

  it("rotates an app credential for its default and named agents", async () => {
    const added = await page("/api/agents", {
      method: "POST",
      body: JSON.stringify({
        id: "claude-dev",
        display_name: "Dev",
        app_id: "claude",
        room_id: roomId,
      }),
    });
    expect(added.status).toBe(201);
    const oldToken = tokens[0]!;
    await runCli("dist/cli/setup.js", ["--rotate"]);
    const setup = readFileSync(join(home, "app-setup.md"), "utf8");
    const freshTokens = [...setup.matchAll(/kfb_[\w-]+/g)].map(
      (match) => match[0],
    );
    expect(freshTokens[0]).not.toBe(oldToken);
    const stale = await fetch(`${url}/agent/join`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${oldToken}`,
      },
      body: JSON.stringify({ room: ROOM }),
    });
    expect(stale.status).toBe(401);
    const named = await fetch(`${url}/agent/join`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${freshTokens[0]}`,
      },
      body: JSON.stringify({ room: ROOM, as: "claude-dev" }),
    });
    expect(named.status).toBe(200);
  });

  it("protects the app and serves the built page", async () => {
    const signedOut = await fetch(`${url}/api/overview`);
    expect(signedOut.status).toBe(401);

    const badToken = await fetch(`${url}/agent/join`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ room: ROOM }),
    });
    expect(badToken.status).toBe(401);

    const badOrigin = await page(`/api/rooms/${roomId}/messages`, {
      method: "POST",
      headers: { Origin: "https://evil.test" },
      body: JSON.stringify({ body: "Hello" }),
    });
    expect(badOrigin.status).toBe(403);

    const home = await fetch(`${url}/`);
    expect(home.ok).toBe(true);
    const html = await home.text();
    expect(html).toContain("<title>Konfab</title>");
    expect(home.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );

    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(script).toBeDefined();
    expect((await fetch(`${url}${script}`)).ok).toBe(true);

    // The page must load nothing from outside this computer.
    const assets = readdirSync(join(ROOT, "dist/web/assets"));
    const external = assets.filter((name) =>
      /(?:src|href)=["']https?:\/\//.test(
        readFileSync(join(ROOT, "dist/web/assets", name), "utf8"),
      ),
    );
    expect(external).toEqual([]);
    expect(html).not.toMatch(/(?:src|href)=["']https?:\/\//);
  });

  it("keeps secrets out of the database and restricts local files", async () => {
    const database = readFileSync(join(home, "konfab.db"));
    expect(database.includes(tokens[0] ?? "missing")).toBe(false);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "app-setup.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "konfab.db")).mode & 0o777).toBe(0o600);
  });
});

describe("the running server's log", () => {
  let home: string;
  let port: number;
  let env: Record<string, string>;
  const children: ChildProcess[] = [];
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "konfab-log-smoke-"));
    port = await new Promise<number>((done) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as AddressInfo;
        probe.close(() => done(free));
      });
    });
    writeFileSync(join(home, "config.yaml"), `server:\n  port: ${port}\n`);
    // As little as macOS gives a login item.
    env = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      KONFAB_HOME: home,
      KONFAB_ISOLATED: "1",
    };
  });
  afterEach(() => {
    for (const child of children.splice(0))
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });
  const log = (name: string) => readFileSync(join(home, "logs", name), "utf8");
  const listening = async () => {
    for (let wait = 0; wait < 100; wait += 1) {
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/overview`)).status;
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    throw new Error("The server didn't start");
  };
  /** In its own group, away from a terminal, with its output thrown away. */
  const start = (script: string, extra: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [join(ROOT, script)], {
      cwd: ROOT,
      env: { ...env, ...extra },
      stdio: "ignore",
      detached: true,
    });
    children.push(child);
    return child;
  };
  const ended = (child: ChildProcess) =>
    new Promise<number | null>((done) =>
      child.exitCode !== null ? done(child.exitCode) : child.once("exit", done),
    );

  it("as a login item, keeps its logs bounded and private, without codes or secrets", async () => {
    const runner = start("dist/cli/login-run.js");
    expect(await listening()).toBe(401);
    await fetch(`http://127.0.0.1:${port}/login?code=kfl_not-a-real-code`);
    await fetch(`http://127.0.0.1:${port}/agent/post`, {
      method: "POST",
      headers: {
        authorization: "Bearer kfb_secret-token",
        cookie: "konfab_session=secret-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: "secret message text" }),
    });
    runner.kill("SIGTERM");
    // A normal stop, so macOS doesn't start it again.
    expect(await ended(runner)).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(log("konfab.log")).toContain("Server listening");
    expect(log("konfab.log")).toContain('"url":"/agent/post"');
    expect(log("output.log")).toContain("npm run login-link");
    for (const name of ["konfab.log", "output.log"]) {
      expect(log(name)).not.toMatch(/kfl_|kfb_|code=|secret/);
      if (process.platform !== "win32")
        expect(statSync(join(home, "logs", name)).mode & 0o777).toBe(0o600);
    }
  }, 60_000);

  it("as a login item, bounds endless output while it runs, and ends with the server after a crash", async () => {
    const noisy = join(home, "noisy.mjs");
    writeFileSync(
      noisy,
      `const line = "x".repeat(1000) + "\\n";
       let sent = 0;
       const more = () => {
         for (; sent < 8000; sent += 1)
           if (!process.stderr.write(line)) { sent += 1; return process.stderr.once("drain", more); }
         setTimeout(() => { throw new Error("crashed on purpose"); }, 300);
       };
       if (process.argv[1].endsWith("server/index.js")) more();`,
    );
    const runner = start("dist/cli/login-run.js", {
      NODE_OPTIONS: `--import=${noisy}`,
    });
    let largest = 0;
    const watch = setInterval(() => {
      for (const name of ["output.log", "output.log.1"])
        try {
          largest = Math.max(largest, statSync(join(home, "logs", name)).size);
        } catch {
          // Not there at this moment.
        }
    }, 5);
    const code = await ended(runner);
    clearInterval(watch);
    expect(code).not.toBe(0);
    expect(largest).toBeGreaterThan(500_000);
    expect(largest).toBeLessThanOrEqual(1024 * 1024);
    expect(
      readdirSync(join(home, "logs")).filter((name) =>
        /^output\.log(\.\d+)?$/.test(name),
      ),
    ).toEqual(["output.log", "output.log.1"]);
    expect(log("output.log")).toContain("crashed on purpose");
    expect(log("output.log")).toContain("Konfab stopped (exit code 1)");
  }, 60_000);

  it("a second start on the same port changes no log of the first, or of earlier versions", async () => {
    mkdirSync(join(home, "logs"));
    const legacy = "old history\n".repeat(600_000);
    writeFileSync(join(home, "logs", "server.log"), legacy);
    const first = start("dist/server/index.js");
    await listening();
    const second = start("dist/server/index.js");
    expect(await ended(second)).not.toBe(0);
    expect(await listening()).toBe(401);
    const writers = log("konfab.log")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { pid: number }).pid);
    expect(new Set(writers)).toEqual(new Set([first.pid]));
    expect(existsSync(join(home, "logs", "konfab.log.1"))).toBe(false);
    first.kill("SIGTERM");
    await ended(first);
    expect(log("server.log")).toBe(legacy);
  }, 60_000);

  it("runs with a log it can't write, and writes it after a restart", async () => {
    writeFileSync(join(home, "logs"), "in the way");
    const first = start("dist/server/index.js");
    expect(await listening()).toBe(401);
    first.kill("SIGTERM");
    expect(await ended(first)).toBe(0);
    rmSync(join(home, "logs"));
    for (let round = 0; round < 2; round += 1) {
      const next = start("dist/server/index.js");
      await listening();
      next.kill("SIGTERM");
      await ended(next);
    }
    expect(log("konfab.log").match(/Server listening/g)).toHaveLength(2);
    expect(log("konfab.log")).not.toContain('"statusCode":200');
  }, 60_000);
});
