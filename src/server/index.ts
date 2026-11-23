import { resolve } from "node:path";
import { buildApp } from "./api/app.js";
import { databasePath, ensureHome, konfabHome, loadConfig } from "./config.js";
import { LogFile, logDirectory } from "./log-file.js";
import { TelegramNotices } from "./telegram/notices.js";
import { resolveTelegramToken } from "./telegram/token.js";
import { createRuntime } from "./runtime.js";
import { resolveGithubToken } from "./github-token.js";

const home = konfabHome();
ensureHome(home);
const logFile = new LogFile(logDirectory(home));
const config = loadConfig(home);
const { db, service, skills, sources } = createRuntime(
  databasePath(home),
  config,
  (() => {
    // An isolated run (the get-started check) never reads stored credentials.
    if (process.env.KONFAB_ISOLATED === "1")
      return { token: undefined, tokenSource: "unavailable" as const };
    const resolved = resolveGithubToken(process.env.KONFAB_GITHUB_TOKEN);
    return { token: resolved.token, tokenSource: resolved.source };
  })(),
);
service.recoverAfterRestart();
service.recoverDeletedRooms();

const notices = new TelegramNotices({
  db,
  home,
  options: config.phone_notices,
  token: (slot) => resolveTelegramToken(slot),
  warn: (message) => app.log.warn(message),
});

const app = await buildApp({
  notices,
  service,
  skills,
  sources,
  skillsHome: home,
  port: config.server.port,
  webDir: resolve(import.meta.dirname, "../web"),
  logger: true,
  logStream: logFile,
});

const tick = setInterval(
  () => service.tick(),
  config.server.tick_seconds * 1000,
);

// Apart from the rooms' own clock, which must not wait for it.
const noticesTick = setInterval(() => void notices.tick(), 15_000);

const shutdown = async (): Promise<void> => {
  clearInterval(tick);
  clearInterval(noticesTick);
  await notices.settled();
  await sources.close();
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: "127.0.0.1", port: config.server.port });
// A parent that started this server (quickstart) learns it is listening from
// the process itself, without probing the port.
process.send?.({ type: "konfab-ready", port: config.server.port });

// Printed directly, so the one-time code stays out of the logs. Only to a
// person's terminal: a login item's output is kept in a file.
console.log(
  process.stdout.isTTY
    ? `\nSign in to Konfab: http://127.0.0.1:${config.server.port}/login?code=${service.createLoginCode()}\n`
    : `Konfab is running on port ${config.server.port}. Run \`npm run login-link\` to sign in.`,
);
if (process.stdout.isTTY) console.log(`Logs: ${logFile.path}`);
