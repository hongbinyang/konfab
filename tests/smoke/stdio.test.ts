import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
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

  const runCli = (script: string): Promise<string> =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, [script], {
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
        `server:\n  port: ${port}`,
        "defaults:",
        `  wait_timeout_seconds: ${WAIT_SECONDS}`,
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
