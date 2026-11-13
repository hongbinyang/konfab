import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 47831;

async function waitForServer(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Konfab did not start on ${url}`);
}

// Starts Konfab in a throwaway home so tests never touch the real
// ~/.konfab or any desktop app configuration.
export default async function globalSetup(): Promise<() => void> {
  const root = mkdtempSync(join(tmpdir(), "konfab-e2e-"));
  const home = join(root, "konfab");
  const fakeHome = join(root, "home");
  mkdirSync(home);
  mkdirSync(fakeHome);
  writeFileSync(join(home, "config.yaml"), `server:\n  port: ${PORT}\n`);
  const env = {
    ...process.env,
    HOME: fakeHome,
    CODEX_HOME: join(fakeHome, ".codex"),
    CLAUDE_CONFIG_DIR: join(fakeHome, ".claude"),
    KONFAB_HOME: home,
  };
  execFileSync("node", ["dist/cli/setup.js", "--manual"], {
    env,
    stdio: "ignore",
  });
  const server = spawn("node", ["dist/server/index.js"], {
    env,
    stdio: "ignore",
  });
  await waitForServer(`http://127.0.0.1:${PORT}/`, 15_000);
  process.env.KONFAB_E2E_HOME = home;
  process.env.KONFAB_E2E_ENV = JSON.stringify({
    HOME: fakeHome,
    KONFAB_HOME: home,
  });
  return () => {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  };
}
