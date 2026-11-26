import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { TOKEN_PATTERN } from "./client.js";

const security = "/usr/bin/security";
const LIMIT_MS = 10_000;
const MAX_BYTES = 8192;
/** macOS's own answer for "there is none". Nothing else means that. */
const NOT_FOUND = 44;

/**
 * Where a setup's token is: an item of its own in the Keychain, one of the two
 * places of earlier versions, or KONFAB_TELEGRAM_TOKEN.
 */
export type TokenSlot = "own" | "a" | "b" | "env";

const OWN = /^konfab-telegram-token-[0-9a-f]{32}$/;
const OLD = /^konfab-telegram-token-[ab]$/;
export const isOwnItem = (item: unknown): item is string =>
  typeof item === "string" && OWN.test(item);
export const isOldItem = (item: unknown): item is string =>
  typeof item === "string" && OLD.test(item);
/** Never made twice, and never replaced. */
export const newItem = (): string =>
  `konfab-telegram-token-${randomBytes(16).toString("hex")}`;
/** Null: the environment. */
export const itemOf = (place: {
  slot: TokenSlot;
  item?: string;
}): string | null =>
  place.slot === "env"
    ? null
    : place.slot === "own"
      ? (place.item ?? "")
      : `konfab-telegram-token-${place.slot}`;

/** The bot a token is for. Not a secret: the rest of the token is. */
export const botId = (token: string): string => token.split(":")[0] ?? "";

/** "none" only if it is surely not there. */
export type TokenRead =
  { state: "found"; token: string } | { state: "none" } | { state: "unknown" };
export type Removed = "deleted" | "none" | "unknown";

export type Ran = { code: number | null; out: string };
export type Run = (args: string[]) => Promise<Ran>;

/** Without a shell, and without holding up the server. */
const run: Run = (args) =>
  new Promise((done) => {
    let out = "";
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.unref();
      done({ code, out });
    };
    const child = spawn(security, args, {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stop = () => {
      child.kill("SIGKILL");
      out = "";
      finish(null);
    };
    const timer = setTimeout(stop, LIMIT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > MAX_BYTES) stop();
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });

/** Where tokens are kept: macOS's Keychain, or private files on Linux. */
export type Kept = "keychain" | "file";

/** Says where, in the same words in the page and the terminal. */
export const keptIn = (kept: Kept | null): string =>
  kept === "file" ? "in Konfab's private token folder" : "in your Keychain";

/** Asks in the terminal without showing what is typed. Null: nothing. */
export type AskHidden = (question: string) => Promise<string | null>;

const RULES = { dir: 0o700, file: 0o600 };
const ERRNO = (error: unknown) => (error as { code?: string }).code;

/**
 * Tokens on Linux: one file per item, only for this user, in a folder only
 * for this user. Never replaced, never followed through a link.
 */
class TokenFiles {
  constructor(private readonly folder: string) {}

  /** Null if it isn't there; throws if it isn't private. */
  private checkedFolder(): string | null {
    let info;
    try {
      info = lstatSync(this.folder);
    } catch (error) {
      if (ERRNO(error) === "ENOENT") return null;
      throw error;
    }
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("not private");
    return this.folder;
  }

  read(item: string): TokenRead {
    let file: number | null = null;
    try {
      const folder = this.checkedFolder();
      if (!folder) return { state: "none" };
      file = openSync(
        join(folder, item),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = fstatSync(file);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.size > MAX_BYTES
      )
        return { state: "unknown" };
      const token = readFileSync(file, "utf8").trim();
      return TOKEN_PATTERN.test(token)
        ? { state: "found", token }
        : { state: "unknown" };
    } catch (error) {
      return ERRNO(error) === "ENOENT"
        ? { state: "none" }
        : { state: "unknown" };
    } finally {
      if (file !== null) closeSync(file);
    }
  }

  remove(item: string): Removed {
    try {
      const folder = this.checkedFolder();
      if (!folder) return "none";
      unlinkSync(join(folder, item));
      return "deleted";
    } catch (error) {
      return ERRNO(error) === "ENOENT" ? "none" : "unknown";
    }
  }

  /** A new file only; false if anything is in the way. */
  store(item: string, token: string): boolean {
    let file: number | null = null;
    let made = false;
    try {
      mkdirSync(this.folder, { mode: RULES.dir, recursive: true });
      const folder = this.checkedFolder()!;
      file = openSync(
        join(folder, item),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        RULES.file,
      );
      made = true;
      writeSync(file, `${token}\n`);
      fsyncSync(file);
      return true;
    } catch {
      if (made) {
        try {
          unlinkSync(join(this.folder, item));
        } catch {
          // Then it is unknown, and the read after it says so.
        }
      }
      return false;
    } finally {
      if (file !== null) closeSync(file);
    }
  }
}

/** Hidden input in a terminal, for Linux, where no system program asks. */
export const askHidden: AskHidden = (question) =>
  new Promise((done) => {
    const input = process.stdin;
    if (!input.isTTY) return done(null);
    process.stdout.write(question);
    let typed = "";
    const finish = (value: string | null) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", key);
      process.stdout.write("\n");
      done(value);
    };
    const key = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish(typed);
        if (char === "\u0003" || char === "\u0004") return finish(null);
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
        else if (char >= " " && typed.length < 200) typed += char;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", key);
  });

export class Keychain {
  private readonly files: TokenFiles | null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly start: Run = run,
    options: { home?: string; ask?: AskHidden } = {},
  ) {
    this.files =
      platform === "linux" && options.home
        ? new TokenFiles(join(options.home, "tokens"))
        : null;
    this.ask = options.ask ?? askHidden;
  }

  private readonly ask: AskHidden;

  /** Where tokens are kept here; null where there is no such place. */
  get kept(): Kept | null {
    return this.platform === "darwin" ? "keychain" : this.files ? "file" : null;
  }

  /** An isolated run never uses stored credentials. */
  get usable(): boolean {
    return this.kept !== null && this.env.KONFAB_ISOLATED !== "1";
  }

  get fromEnvironment(): boolean {
    return Boolean(this.env.KONFAB_TELEGRAM_TOKEN);
  }

  /** Of this place only. Never logged, shown or given to an agent. */
  async read(place: { slot: TokenSlot; item?: string }): Promise<TokenRead> {
    const item = itemOf(place);
    if (item === null) {
      const token = this.env.KONFAB_TELEGRAM_TOKEN?.trim();
      return token && TOKEN_PATTERN.test(token)
        ? { state: "found", token }
        : { state: "none" };
    }
    if (!this.usable) return { state: "none" };
    if (!isOwnItem(item) && !isOldItem(item)) return { state: "unknown" };
    if (this.files) return this.files.read(item);
    let ran: Ran;
    try {
      ran = await this.start([
        "find-generic-password",
        "-a",
        userInfo().username,
        "-s",
        item,
        "-w",
      ]);
    } catch {
      return { state: "unknown" };
    }
    if (ran.code === NOT_FOUND) return { state: "none" };
    const token = ran.out.trim();
    // Output is never shown.
    return ran.code === 0 && TOKEN_PATTERN.test(token)
      ? { state: "found", token }
      : { state: "unknown" };
  }

  /** Only names that Konfab makes. */
  async remove(item: string): Promise<Removed> {
    if (!this.usable || (!isOwnItem(item) && !isOldItem(item)))
      return "unknown";
    if (this.files) return this.files.remove(item);
    try {
      const { code } = await this.start([
        "delete-generic-password",
        "-a",
        userInfo().username,
        "-s",
        item,
      ]);
      return code === 0 ? "deleted" : code === NOT_FOUND ? "none" : "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * In a terminal: macOS's own command asks for it with hidden input. Without
   * "replace", so that nothing that is there is changed. On Linux Konfab asks.
   */
  async storeByHand(item: string): Promise<boolean> {
    if (!this.usable || !isOwnItem(item)) return false;
    if (this.files) {
      const token = (await this.ask("Bot token: "))?.trim() ?? "";
      return TOKEN_PATTERN.test(token) && this.files.store(item, token);
    }
    return (
      spawnSync(
        security,
        ["add-generic-password", "-a", userInfo().username, "-s", item, "-w"],
        { stdio: "inherit" },
      ).status === 0
    );
  }
}
