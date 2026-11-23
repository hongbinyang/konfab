import { execFileSync, spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { TOKEN_PATTERN } from "./client.js";

const security = "/usr/bin/security";

/**
 * Where a setup's token is. A new setup uses the Keychain slot that the
 * current one doesn't, so the current one keeps working until the new one is
 * complete. "env" is KONFAB_TELEGRAM_TOKEN.
 */
export type TokenSlot = "a" | "b" | "env";
export const KEYCHAIN_SLOTS = ["a", "b"] as const;
const service = (slot: TokenSlot) => `konfab-telegram-token-${slot}`;

/** The bot a token is for. Not a secret: the rest of the token is. */
export const botId = (token: string): string => token.split(":")[0] ?? "";

type Read = (args: string[]) => string;
const readKeychain: Read = (args) =>
  execFileSync(security, args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8192,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** The token in this slot only, or null. Never logged, shown or given to an agent. */
export function resolveTelegramToken(
  slot: TokenSlot,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  read: Read = readKeychain,
): string | null {
  let token: string | undefined;
  if (slot === "env") token = env.KONFAB_TELEGRAM_TOKEN?.trim();
  // An isolated run never reads stored credentials.
  else if (platform === "darwin" && env.KONFAB_ISOLATED !== "1") {
    try {
      token = read([
        "find-generic-password",
        "-a",
        userInfo().username,
        "-s",
        service(slot),
        "-w",
      ]).trim();
    } catch {
      // None is stored, or it can't be read. Command output is never shown.
    }
  }
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

/** Asks for the token with hidden input, in macOS's own command. */
export function storeTelegramToken(slot: TokenSlot): boolean {
  return (
    spawnSync(
      security,
      [
        "add-generic-password",
        "-a",
        userInfo().username,
        "-s",
        service(slot),
        "-U",
        "-w",
      ],
      { stdio: "inherit" },
    ).status === 0
  );
}

export function removeTelegramToken(slot: TokenSlot): boolean {
  if (process.platform !== "darwin" || slot === "env") return true;
  const { status } = spawnSync(
    security,
    ["delete-generic-password", "-a", userInfo().username, "-s", service(slot)],
    { stdio: "ignore" },
  );
  // 44: there was none.
  return status === 0 || status === 44;
}
