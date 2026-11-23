import { execFileSync, spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { TOKEN_PATTERN } from "./client.js";

const security = "/usr/bin/security";
const service = "konfab-telegram-token";

type Read = (args: string[]) => string;
const readKeychain: Read = (args) =>
  execFileSync(security, args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8192,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** The bot token, or null. Never logged, shown or given to an agent. */
export function resolveTelegramToken(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  read: Read = readKeychain,
): string | null {
  let token = env.KONFAB_TELEGRAM_TOKEN?.trim();
  // An isolated run never reads stored credentials.
  if (!token && platform === "darwin" && env.KONFAB_ISOLATED !== "1") {
    try {
      token = read([
        "find-generic-password",
        "-a",
        userInfo().username,
        "-s",
        service,
        "-w",
      ]).trim();
    } catch {
      // None is stored, or it can't be read. Command output is never shown.
    }
  }
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

/** Asks for the token with hidden input, in macOS's own command. */
export function storeTelegramToken(): boolean {
  return (
    spawnSync(
      security,
      [
        "add-generic-password",
        "-a",
        userInfo().username,
        "-s",
        service,
        "-U",
        "-w",
      ],
      { stdio: "inherit" },
    ).status === 0
  );
}

export function removeTelegramToken(): boolean {
  if (process.platform !== "darwin") return true;
  const { status } = spawnSync(
    security,
    ["delete-generic-password", "-a", userInfo().username, "-s", service],
    { stdio: "ignore" },
  );
  // 44: there was none.
  return status === 0 || status === 44;
}
