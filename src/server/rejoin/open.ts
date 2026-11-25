import { lstatSync } from "node:fs";
import { runCommand, type RunResult } from "./codex.js";

/**
 * Brings an app to the front, on the lead's click only. A fixed command with
 * a fixed path: nothing anyone wrote is in it. Konfab sees whether the command
 * worked, never which conversation or account the app then shows.
 */
export type App = "codex" | "claude";

const OPEN = "/usr/bin/open";
const LIMIT_MS = 5_000;
const PATHS: Record<App, string> = {
  codex: "/Applications/ChatGPT.app",
  claude: "/Applications/Claude.app",
};

export type OpenOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Test seams. */
  isApp?: (path: string) => boolean;
  run?: (
    path: string,
    args: string[],
    timeoutMs: number,
    env?: NodeJS.ProcessEnv,
  ) => Promise<RunResult>;
};

function isFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function canOpen(app: App, options: OpenOptions = {}): boolean {
  return (
    (options.platform ?? process.platform) === "darwin" &&
    (options.isApp ?? isFolder)(PATHS[app])
  );
}

/** Whether the command worked. Nothing more is known by it. */
export async function openApp(
  app: App,
  options: OpenOptions = {},
): Promise<boolean> {
  if (!canOpen(app, options)) return false;
  try {
    const result = await (options.run ?? runCommand)(
      OPEN,
      ["-a", PATHS[app]],
      LIMIT_MS,
      options.env ?? process.env,
    );
    return result.started && result.complete && result.code === 0;
  } catch {
    return false;
  }
}
