import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  loginItemPlist,
  LOGIN_ITEM_LABEL,
} from "../../cli/login-item-plist.js";

/**
 * Start at login, from the page: only the LaunchAgent's file, for the next
 * login. The running Konfab is neither started nor stopped, except when the
 * lead chooses to unload the job, which ends this server. Seen in the launchd
 * trial of 2026-11-26: a file alone doesn't load a job, and changing or
 * removing the file leaves a loaded job as it is until it is unloaded.
 */
export type LoginItemView = {
  available: boolean;
  /**
   * The file: none, this version's, one of an earlier Konfab, or one Konfab
   * doesn't know (which it leaves alone), or a link (left alone too).
   */
  file: "none" | "current" | "earlier" | "unknown" | "link";
  /** Loaded in launchd now; then it runs until it is unloaded or logout. */
  loaded: boolean;
  path: string;
  /** What the lead's yes is for; a change is refused if the file differs. */
  stamp: string;
  /** The last unload the lead chose, when it was done after answering. */
  last_unload: { ok: boolean; said: string } | null;
};

export type Launchctl = (args: string[]) => { code: number | null };

const run: Launchctl = (args) => ({
  code: spawnSync("/bin/launchctl", args, {
    stdio: "ignore",
    timeout: 10_000,
  }).status,
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export class LoginItem {
  readonly path: string;
  private readonly domain: string;
  private lastUnload: LoginItemView["last_unload"] = null;

  constructor(
    private readonly deps: {
      platform?: NodeJS.Platform;
      home?: string;
      uid?: number;
      launchctl?: Launchctl;
      /** What the file says: this Node, this runner, this folder. */
      plist: () => string;
      /** Exactly the files that earlier versions of this Konfab wrote. */
      earlier?: RegExp[];
    },
  ) {
    this.path = join(
      deps.home ?? homedir(),
      "Library/LaunchAgents",
      `${LOGIN_ITEM_LABEL}.plist`,
    );
    this.domain = `gui/${deps.uid ?? userInfo().uid}`;
  }

  private get launchctl(): Launchctl {
    return this.deps.launchctl ?? run;
  }

  get available(): boolean {
    return (this.deps.platform ?? process.platform) === "darwin";
  }

  /** The file as it is: none, a link, or its identity and hash. */
  private stampNow(): string {
    try {
      const info = lstatSync(this.path);
      if (info.isSymbolicLink()) return "link";
      return `${info.dev}:${info.ino}:${sha(readFileSync(this.path, "utf8"))}`;
    } catch {
      return "none";
    }
  }

  /** Konfab's own job, of this version or an earlier one. */
  private kind(): LoginItemView["file"] {
    const stamp = this.stampNow();
    if (stamp === "none" || stamp === "link") return stamp;
    const text = readFileSync(this.path, "utf8");
    if (text === this.deps.plist()) return "current";
    // Only a file of exactly a known shape, for this Konfab folder; anything
    // else, also with the same label, isn't Konfab's to change.
    return (this.deps.earlier ?? []).some((shape) => shape.test(text))
      ? "earlier"
      : "unknown";
  }

  view(): LoginItemView {
    const base = { path: this.path, last_unload: this.lastUnload };
    if (!this.available)
      return {
        ...base,
        available: false,
        file: "none",
        loaded: false,
        stamp: "none",
      };
    return {
      ...base,
      available: true,
      file: this.kind(),
      // Read only.
      loaded:
        this.launchctl(["print", `${this.domain}/${LOGIN_ITEM_LABEL}`]).code ===
        0,
      stamp: this.stampNow(),
    };
  }

  /** Only the file that the lead was shown, and only Konfab's own. */
  private check(stamp: string): void {
    this.mustBeAvailable();
    if (this.stampNow() !== stamp)
      throw new LoginItemError(
        "The file has changed since; nothing was done. Look again.",
      );
    const kind = this.kind();
    if (kind === "link" || kind === "unknown")
      throw new LoginItemError(
        `${this.path} isn't one that Konfab wrote${kind === "link" ? " (it is a link)" : ""}; Konfab leaves it alone. Change it by hand.`,
      );
  }

  /** The file for the next login. Nothing is loaded or started now. */
  turnOn(stamp: string): void {
    this.check(stamp);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, this.deps.plist(), { mode: 0o600, flag: "wx" });
      // The last look, right before the file is replaced.
      if (this.stampNow() !== stamp)
        throw new LoginItemError(
          "The file has changed since; nothing was done. Look again.",
        );
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /**
   * No start at the next login. A loaded job stays loaded, and this Konfab
   * keeps running; unloading is its own step (unload).
   */
  turnOff(stamp: string): void {
    this.check(stamp);
    rmSync(this.path, { force: true });
  }

  /**
   * Ends a Konfab that launchd started, this one too, so it is done after the
   * answer was sent. Never throws; what happened is shown next time, if
   * this Konfab still runs.
   */
  unload(): void {
    this.mustBeAvailable();
    try {
      const { code } = this.launchctl([
        "bootout",
        `${this.domain}/${LOGIN_ITEM_LABEL}`,
      ]);
      this.lastUnload =
        code === 0
          ? { ok: true, said: "Unloaded." }
          : {
              ok: false,
              said:
                code === null
                  ? "macOS didn't answer in time; it may still be loaded."
                  : `macOS refused to unload it (code ${code}).`,
            };
    } catch {
      this.lastUnload = { ok: false, said: "It couldn't be unloaded." };
    }
  }

  private mustBeAvailable(): void {
    if (!this.available)
      throw new LoginItemError(
        "Not available here; start Konfab with your own service manager.",
      );
  }
}
export class LoginItemError extends Error {}

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ANY_PATH = "(/[^<]*)";

/**
 * The files that this Konfab folder's earlier versions wrote: with
 * `dist/server/index.js` and a log file (before the runner), and this
 * version's with another Node (after a Node update). Exact, but for the Node
 * and log paths.
 */
export function earlierShapes(paths: {
  runner: string;
  workingDirectory: string;
}): RegExp[] {
  const node = "\u0000NODE\u0000";
  const log = "\u0000LOG\u0000";
  const current = loginItemPlist({
    nodePath: node,
    runnerPath: paths.runner,
    workingDirectory: paths.workingDirectory,
  });
  const before = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LOGIN_ITEM_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${xml(join(paths.workingDirectory, "dist/server/index.js"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
  return [current, before].map(
    (text) =>
      new RegExp(
        `^${literal(text).replaceAll(node, ANY_PATH).replace(log, ANY_PATH).replace(log, "\\2")}$`,
      ),
  );
}

/** As `npm run login-item -- install` writes it. */
export const plistFor =
  (paths: { runner: string; workingDirectory: string }) => () =>
    loginItemPlist({
      nodePath: process.execPath,
      runnerPath: paths.runner,
      workingDirectory: paths.workingDirectory,
    });
