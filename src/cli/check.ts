import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseDocument } from "yaml";
import { readCodex } from "./connector-config.js";

/**
 * End-to-end check of a fresh install, safe by construction: everything runs
 * in a temporary folder of its own, with credentials removed from the
 * environment, on a free port, and nothing outside that folder is read or
 * written. It sets up connectors there, starts the server with no prior
 * config or database, connects the bridge exactly as an app would, takes a
 * turn, restarts the server and checks the room is still there.
 */

const root = resolve(import.meta.dirname, "../..");
const ROOM = "get-started-check";
const PREFIX = "konfab-check-";

/** Names never passed on: credentials and anything that points Konfab or the apps elsewhere. */
const DROP =
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|AUTH|COOKIE|SESSION|^KONFAB_|^CODEX_|^CLAUDE_|^ANTHROPIC_|^OPENAI_|^GITHUB_|^GH_|^HOME$|^USERPROFILE$|^XDG_/i;

export function isolatedEnvironment(
  base: NodeJS.ProcessEnv,
  dir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && !DROP.test(key)) env[key] = value;
  const home = join(dir, "home");
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    KONFAB_HOME: join(dir, "konfab"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: home,
    KONFAB_ISOLATED: "1",
  };
}

async function freePort(): Promise<number> {
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

export async function runCheck(
  log: (line: string) => void = console.log,
): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), PREFIX)));
  const env = isolatedEnvironment(process.env, dir);
  mkdirSync(env.CODEX_HOME!, { recursive: true });
  // Claude Code leaves this file on first run; an empty one stands in for it.
  writeFileSync(join(env.CLAUDE_CONFIG_DIR!, ".claude.json"), "{}\n");
  let server: ChildProcess | undefined;
  let client: Client | undefined;
  const node = (script: string, args: string[] = []) => {
    const result = spawnSync(process.execPath, [join(root, script), ...args], {
      env,
      encoding: "utf8",
    });
    if (result.status !== 0)
      throw new Error(`${script} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  const start = async (url: string) => {
    const child = spawn(
      process.execPath,
      [join(root, "dist/server/index.js")],
      {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    for (let i = 0; i < 100; i += 1) {
      if (child.exitCode !== null)
        throw new Error(`The server stopped: ${stderr}`);
      try {
        await fetch(`${url}/login`, { redirect: "manual" });
        return child;
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    child.kill();
    throw new Error("The server didn't answer within 10 seconds.");
  };
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null) return;
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await exited;
  };
  const signIn = async () => {
    const link = node("dist/cli/login-link.js").trim();
    const response = await fetch(link, { redirect: "manual" });
    if (response.status !== 303) throw new Error("Sign-in failed.");
    return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  try {
    log(`Working in ${dir} (removed afterwards).`);
    // Setup writes the default config and the connector entries, as on a first
    // run. The check then moves to a free port and runs setup again (which
    // also proves a rerun keeps the tokens), so nothing talks to port 8787.
    node("dist/cli/setup.js");
    const configFile = join(env.KONFAB_HOME!, "config.yaml");
    const config = parseDocument(readFileSync(configFile, "utf8"));
    const port = await freePort();
    config.setIn(["server", "port"], port);
    writeFileSync(configFile, config.toString());
    node("dist/cli/setup.js");
    const url = `http://127.0.0.1:${port}`;
    log(
      "Setup wrote the default config and both connector entries; a rerun kept them.",
    );

    server = await start(url);
    let cookie = await signIn();
    const page = (path: string, init: RequestInit = {}) =>
      fetch(`${url}${path}`, {
        ...init,
        headers: { cookie, "Content-Type": "application/json" },
      });
    const created = await page("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name: ROOM, topic: "Check", members: ["codex"] }),
    });
    if (created.status !== 201) throw new Error("Couldn't create a room.");
    const roomId = ((await created.json()) as { id: number }).id;
    log("Server started with a fresh database; room created.");

    // The bridge starts exactly as Codex would start it, from the entry setup wrote.
    const entry = readCodex(
      readFileSync(join(env.CODEX_HOME!, "config.toml"), "utf8"),
    ).mcp_servers as Record<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    >;
    const konfab = entry.konfab!;
    if (konfab.env.KONFAB_URL !== url)
      throw new Error(
        `The connector points at ${konfab.env.KONFAB_URL}, not this check's server.`,
      );
    client = new Client({ name: "get-started-check", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: konfab.command,
        args: konfab.args,
        env: { ...env, ...konfab.env },
        stderr: "ignore",
      }),
    );
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = (await client!.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text?: string }>;
      };
      if (result.isError) throw new Error(result.content[0]?.text);
      return JSON.parse(result.content[0]?.text ?? "null") as Record<
        string,
        unknown
      >;
    };
    const session = (await tool("join_room", { room: ROOM })).session_id;
    await page(`/api/rooms/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "@codex please reply" }),
    });
    const turn = await tool("wait_for_turn", { session_id: session });
    if (turn.status !== "turn") throw new Error("The agent got no turn.");
    await tool("post_message", {
      session_id: session,
      turn_id: turn.turn_id,
      body: "Reply from the check",
      next: { kind: "lead" },
    });
    log("The bridge joined as codex, took a turn and replied.");
    await client.close();
    client = undefined;

    await stop(server);
    server = await start(url);
    cookie = await signIn();
    const state = (await (await page(`/api/rooms/${roomId}`)).json()) as {
      messages?: Array<{ body: string }>;
    };
    if (
      !state.messages?.some(
        (message) => message.body === "Reply from the check",
      )
    )
      throw new Error("The room's messages didn't survive a restart.");
    log("After a restart the room and its messages are still there.");
  } finally {
    await client?.close().catch(() => undefined);
    if (server) await stop(server).catch(() => undefined);
    // Remove only the folder this check created.
    if (dir.startsWith(realpathSync(tmpdir()) + sep) && dir.includes(PREFIX))
      rmSync(dir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(import.meta.filename)
)
  runCheck().then(
    () => console.log("Check passed."),
    (error: unknown) => {
      console.error(`Check failed: ${(error as Error).message}`);
      process.exitCode = 1;
    },
  );
