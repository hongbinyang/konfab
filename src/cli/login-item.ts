import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { konfabHome } from "../server/config.js";
import { loginItemPlist, LOGIN_ITEM_LABEL } from "./login-item-plist.js";

const plistPath = join(
  homedir(),
  "Library/LaunchAgents",
  `${LOGIN_ITEM_LABEL}.plist`,
);
const domain = `gui/${userInfo().uid}`;
const action = process.argv[2];

const launchctl = (...args: string[]): void => {
  execFileSync("launchctl", args, { stdio: "ignore" });
};

const uninstall = (): void => {
  if (!existsSync(plistPath)) return;
  try {
    launchctl("bootout", `${domain}/${LOGIN_ITEM_LABEL}`);
  } catch {
    // It was not running, so there is nothing to stop.
  }
  rmSync(plistPath);
};

if (action === "install") {
  const home = konfabHome();
  const logDir = join(home, "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  uninstall();
  mkdirSync(dirname(plistPath), { recursive: true });
  const here = dirname(fileURLToPath(import.meta.url));
  writeFileSync(
    plistPath,
    loginItemPlist({
      nodePath: process.execPath,
      serverPath: resolve(here, "../server/index.js"),
      workingDirectory: resolve(here, "../.."),
      logPath: join(logDir, "server.log"),
    }),
    { mode: 0o600 },
  );
  launchctl("bootstrap", domain, plistPath);
  console.log("Konfab will now start when you log in, and is running now.");
  console.log("Run `npm run login-link` to sign in.");
} else if (action === "uninstall") {
  uninstall();
  console.log("Konfab will no longer start when you log in.");
} else {
  console.error("Usage: npm run login-item -- install|uninstall");
  process.exitCode = 1;
}
