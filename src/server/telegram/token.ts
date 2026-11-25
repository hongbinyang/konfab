import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
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

export class Keychain {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly start: Run = run,
  ) {}

  /** An isolated run never uses stored credentials. */
  get usable(): boolean {
    return this.platform === "darwin" && this.env.KONFAB_ISOLATED !== "1";
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
   * "replace", so that nothing that is there is changed.
   */
  storeByHand(item: string): boolean {
    if (!this.usable || !isOwnItem(item)) return false;
    return (
      spawnSync(
        security,
        ["add-generic-password", "-a", userInfo().username, "-s", item, "-w"],
        { stdio: "inherit" },
      ).status === 0
    );
  }
}
