import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
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
 * trial of 2026-11-27: a file alone doesn't load a job, and changing or
 * removing the file leaves a loaded job as it is until it is unloaded.
 */
export type LoginItemView = {
  available: boolean;
  /** The file: none, this Konfab's, or one of an earlier version. */
  file: "none" | "current" | "earlier";
  /** Loaded in launchd now; then it runs until it is unloaded or logout. */
  loaded: boolean;
  path: string;
};

export type Launchctl = (args: string[]) => { code: number | null };

const run: Launchctl = (args) => ({
  code: spawnSync("/bin/launchctl", args, {
    stdio: "ignore",
    timeout: 10_000,
  }).status,
});

export class LoginItem {
  readonly path: string;
  private readonly domain: string;

  constructor(
    private readonly deps: {
      platform?: NodeJS.Platform;
      home?: string;
      uid?: number;
      launchctl?: Launchctl;
      /** What the file says: this Node, this runner, this folder. */
      plist: () => string;
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

  view(): LoginItemView {
    if (!this.available)
      return { available: false, file: "none", loaded: false, path: this.path };
    let file: LoginItemView["file"] = "none";
    if (existsSync(this.path)) {
      const text = readFileSync(this.path, "utf8");
      file = text === this.deps.plist() ? "current" : "earlier";
    }
    return {
      available: true,
      file,
      // Read only.
      loaded:
        this.launchctl(["print", `${this.domain}/${LOGIN_ITEM_LABEL}`]).code ===
        0,
      path: this.path,
    };
  }

  /** The file for the next login. Nothing is loaded or started now. */
  turnOn(): void {
    this.mustBeAvailable();
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink())
      throw new LoginItemError(
        `${this.path} is a link; Konfab doesn't write through it.`,
      );
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, this.deps.plist(), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /**
   * No start at the next login. A loaded job stays loaded, and this Konfab
   * keeps running, unless `unload`: that ends a Konfab started by launchd,
   * this one too.
   */
  turnOff(unload: boolean): void {
    this.mustBeAvailable();
    rmSync(this.path, { force: true });
    if (unload)
      this.launchctl(["bootout", `${this.domain}/${LOGIN_ITEM_LABEL}`]);
  }

  private mustBeAvailable(): void {
    if (!this.available)
      throw new LoginItemError(
        "Not available here; start Konfab with your own service manager.",
      );
  }
}

export class LoginItemError extends Error {}

/** As `npm run login-item -- install` writes it. */
export const plistFor =
  (paths: { runner: string; workingDirectory: string }) => () =>
    loginItemPlist({
      nodePath: process.execPath,
      runnerPath: paths.runner,
      workingDirectory: paths.workingDirectory,
    });
