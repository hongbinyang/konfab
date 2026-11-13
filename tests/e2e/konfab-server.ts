import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type KonfabServer = {
  baseUrl: string;
  env: Record<string, string>;
  root: string;
  stop: () => void;
};

// A placeholder that can never authenticate. Setting it stops the server
// from falling back to the real macOS Keychain item.
export const SYNTHETIC_GITHUB_TOKEN = "konfab-e2e-synthetic-token";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function loginCode(env: Record<string, string>): string {
  const output = execFileSync("node", ["dist/cli/login-link.js"], {
    env,
    encoding: "utf8",
  });
  const code = /[?&]code=([^\s&]+)/.exec(output)?.[1];
  if (!code) throw new Error("login-link printed no code");
  return code;
}

// Proves the server on the port is the one we started: only our database
// holds the login code, and only Konfab answers it with a session cookie.
async function isOurServer(baseUrl: string, code: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/login?code=${code}`, {
      redirect: "manual",
    });
    return (
      response.status === 303 &&
      (response.headers.get("set-cookie") ?? "").startsWith("konfab_session=")
    );
  } catch {
    return false;
  }
}

async function waitForOwnServer(
  child: ChildProcess,
  baseUrl: string,
  env: Record<string, string>,
  stderr: () => string,
  ms: number,
): Promise<void> {
  const code = loginCode(env);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Konfab exited before it was ready (${child.exitCode ?? child.signalCode}): ${stderr().slice(-500)}`,
      );
    if (await isOurServer(baseUrl, code)) {
      if (child.exitCode === null) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Konfab did not answer on ${baseUrl}`);
}

// Starts a built Konfab server in a throwaway home with a fake HOME, so it
// never touches ~/.konfab, desktop-app settings or real credentials.
export async function startKonfab(
  options: { port?: number; timeoutMs?: number } = {},
): Promise<KonfabServer> {
  const root = mkdtempSync(join(tmpdir(), "konfab-e2e-"));
  let child: ChildProcess | undefined;
  const stop = () => {
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const port = options.port ?? (await freePort());
    const home = join(root, "konfab");
    const fakeHome = join(root, "home");
    mkdirSync(home);
    mkdirSync(fakeHome);
    writeFileSync(join(home, "config.yaml"), `server:\n  port: ${port}\n`);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: fakeHome,
      CODEX_HOME: join(fakeHome, ".codex"),
      CLAUDE_CONFIG_DIR: join(fakeHome, ".claude"),
      KONFAB_HOME: home,
      KONFAB_GITHUB_TOKEN: SYNTHETIC_GITHUB_TOKEN,
    };
    execFileSync("node", ["dist/cli/setup.js", "--manual"], {
      env,
      stdio: "ignore",
    });
    let errors = "";
    child = spawn("node", ["dist/server/index.js"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-4000);
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForOwnServer(
      child,
      baseUrl,
      env,
      () => errors,
      options.timeoutMs ?? 15_000,
    );
    return { baseUrl, env, root, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
