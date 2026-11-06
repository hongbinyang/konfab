import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
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

describe("built server and bridge over real stdio", () => {
  let home: string;
  let url: string;
  let env: NodeJS.ProcessEnv;
  let server: ChildProcess;
  let tokens: string[];
  let clients: Client[];

  const runSetup = (): Promise<void> =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, ["dist/cli/setup.js"], {
        cwd: ROOT,
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let errors = "";
      child.stderr?.on("data", (chunk: Buffer) => (errors += chunk.toString()));
      child.on("close", (code) =>
        code === 0
          ? done()
          : fail(new Error(`Setup exited with ${code}: ${errors}`)),
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
        if ((await fetch(`${url}/api/state`)).ok) return child;
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
    const client = new Client({ name: "e2e", version: "1.0.0" });
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

  const userPost = (body: string): Promise<Response> =>
    fetch(`${url}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });

  const roomState = async (): Promise<RoomState> =>
    (await (await fetch(`${url}/api/state`)).json()) as RoomState;

  beforeEach(async () => {
    clients = [];
    home = mkdtempSync(join(tmpdir(), "konfab-e2e-"));
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    env = { ...process.env, KONFAB_HOME: home };
    writeFileSync(
      join(home, "config.yaml"),
      `server:\n  port: ${port}\ndefaults:\n  wait_timeout_seconds: ${WAIT_SECONDS}\n`,
      { mode: 0o600 },
    );
    await runSetup();
    const setup = readFileSync(join(home, "app-setup.md"), "utf8");
    tokens = [...setup.matchAll(/kfb_[\w-]+/g)].map((match) => match[0]);
    server = await startServer();
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
    const a = (await tool(claude, "join_room", { room: "test" })).session_id;
    const b = (await tool(codex, "join_room", { room: "test" })).session_id;

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
    await stopServer(server);
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

  it("rejects a bad token and an untrusted origin, and serves the page", async () => {
    const badToken = await fetch(`${url}/agent/join`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ room: "test" }),
    });
    expect(badToken.status).toBe(401);

    const badOrigin = await fetch(`${url}/api/messages`, {
      method: "POST",
      headers: {
        Origin: "https://evil.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: "Hello" }),
    });
    expect(badOrigin.status).toBe(403);

    const page = await fetch(`${url}/`);
    expect(page.ok).toBe(true);
    expect(await page.text()).toContain("Konfab");
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
  });

  it("keeps secrets out of the database and restricts local file access", async () => {
    const database = readFileSync(join(home, "konfab.db"));
    expect(database.includes(tokens[0] ?? "missing")).toBe(false);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "app-setup.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "konfab.db")).mode & 0o777).toBe(0o600);
  });
});
