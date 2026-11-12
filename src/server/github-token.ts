import { execFileSync, spawnSync } from "node:child_process";
import { userInfo } from "node:os";

const security = "/usr/bin/security";
const service = "konfab-github-token";
export type TokenSource = "environment" | "keychain" | "unavailable";

type Dependencies = {
  platform: NodeJS.Platform;
  username: () => string;
  read: (args: string[]) => string;
};
const defaults: Dependencies = {
  platform: process.platform,
  username: () => userInfo().username,
  read: (args) =>
    execFileSync(security, args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8192,
      stdio: ["ignore", "pipe", "ignore"],
    }),
};

export function resolveGithubToken(
  envToken: string | undefined,
  deps: Dependencies = defaults,
): { token: string | undefined; source: TokenSource } {
  if (envToken) return { token: envToken, source: "environment" };
  if (deps.platform === "darwin") {
    try {
      const token = deps
        .read([
          "find-generic-password",
          "-a",
          deps.username(),
          "-s",
          service,
          "-w",
        ])
        .replace(/\r?\n$/, "");
      if (token) return { token, source: "keychain" };
    } catch {
      /* Missing item or inaccessible Keychain; never log command output. */
    }
  }
  return { token: undefined, source: "unavailable" };
}

export function setupGithubToken(args: string[]): void {
  if (process.platform !== "darwin")
    throw new Error("GitHub token setup requires macOS Keychain.");
  if (
    args.filter((a) => a === "--github-token").length !== 1 ||
    args.some((a) => a !== "--github-token" && a !== "--remove") ||
    args.filter((a) => a === "--remove").length > 1
  )
    throw new Error(
      "Use --github-token, optionally with --remove, on its own.",
    );
  const remove = args.includes("--remove");
  if (!remove && !process.stdin.isTTY)
    throw new Error("Run token setup in an interactive terminal.");
  const account = userInfo().username;
  const command = remove
    ? ["delete-generic-password", "-a", account, "-s", service]
    : ["add-generic-password", "-a", account, "-s", service, "-U", "-w"];
  const result = spawnSync(security, command, {
    stdio: remove ? "ignore" : "inherit",
  });
  if (remove && result.status === 44) {
    console.log("No stored GitHub token; nothing to remove.");
    return;
  }
  if (result.status !== 0) throw new Error("Keychain operation failed.");
  console.log(
    remove
      ? "Removed the stored GitHub token."
      : "Saved or updated the stored GitHub token.",
  );
}
