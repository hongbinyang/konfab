import { join, resolve } from "node:path";
import { buildApp } from "./api/app.js";
import {
  databasePath,
  ensureHome,
  konfabHome,
  loadConfig,
  type Config,
} from "./config.js";
import { LiveSettings } from "./live-settings.js";
import { isAgreed, noteFirst } from "./rejoin/own-command.js";
import { readSettingsFile, tidySettingsFiles } from "./settings-file.js";
import { LogFile, logDirectory } from "./log-file.js";
import { TelegramNotices } from "./telegram/notices.js";
import { TelegramClient } from "./telegram/client.js";
import { PhoneSetup } from "./telegram/setup.js";
import { Keychain } from "./telegram/token.js";
import { checkCommand, sendRejoin } from "./rejoin/codex.js";
import { canOpen, openApp } from "./rejoin/open.js";
import { macProcesses } from "./rejoin/processes.js";
import { Watchers } from "./rejoin/watchers.js";
import { createRuntime } from "./runtime.js";
import { resolveGithubToken } from "./github-token.js";

const home = konfabHome();
ensureHome(home);
const logFile = new LogFile(logDirectory(home));
const config = loadConfig(home);
const { db, service, skills, sources, useConfig } = createRuntime(
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

tidySettingsFiles(home);
/** A link, for example: it can be used, but isn't changed or followed. */
const firstHash = (): string => {
  try {
    return readSettingsFile(home).hash;
  } catch {
    return "";
  }
};
const live = new LiveSettings(
  {
    home,
    port: config.server.port,
    apply: applySettings,
    changed: () => service.changed(),
    warn: (message) => app.log.warn(message),
  },
  { config, hash: firstHash() },
);

// The lead's button that asks Codex agents to rejoin. What it uses can change
// while the server runs, so each use takes the values of that moment.
noteFirst(home, config.rejoin.codex_command);
const rejoinCommand = (from: Config["rejoin"] = live.inUse.rejoin) => ({
  enabled: from.enabled,
  command: from.codex_command,
  allowUntested: from.allow_untested_version,
  agreed: (path: string, stamp: string) => isAgreed(home, path, stamp),
});
service.rejoin.wantedMs = config.rejoin.wanted_minutes * 60_000;
let rejoinReady = false;
let rejoinProblem = false;
service.rejoin.available = () => rejoinReady;
service.rejoin.problem = () => rejoinProblem;
// Only by the lead's click, and not from an isolated test server.
const opensApps = () =>
  live.inUse.rejoin.enabled &&
  live.inUse.rejoin.open_apps &&
  process.env.KONFAB_ISOLATED !== "1";
service.rejoin.opens = (app) => opensApps() && canOpen(app);
/** At the start, after a refusal or a change, and now and then while it can't be used. */
let recheck: NodeJS.Timeout | undefined;
let check = 0;
const checkRejoin = async (): Promise<void> => {
  clearTimeout(recheck);
  const mine = (check += 1);
  const { enabled } = live.inUse.rejoin;
  const checked = await checkCommand(rejoinCommand());
  // Another check has begun since, with newer values.
  if (mine !== check) return;
  rejoinReady = checked.ok;
  rejoinProblem = !checked.ok && !checked.off;
  if (!rejoinReady && enabled)
    // A yes on the command line comes a moment after the change.
    recheck = setTimeout(
      () => void checkRejoin(),
      !checked.ok && checked.asks ? 5_000 : 10 * 60_000,
    ).unref();
  service.changed();
};

// For agents whose app wakes them when a command they started ends.
const watchers = new Watchers({
  db,
  rejoin: service.rejoin,
  folder: join(resolve(home), "watch"),
  script: resolve(import.meta.dirname, "../cli/watch.js"),
  node: process.execPath,
  port: config.server.port,
  uid: process.getuid?.() ?? -1,
  processes: macProcesses(),
  isWaiting: (agentId, conversation) =>
    service.isWaitingIn(agentId, conversation),
  changed: () => service.changed(),
});
const watches = (from: Config["rejoin"]) =>
  from.enabled &&
  from.claude_watcher &&
  process.platform === "darwin" &&
  process.env.KONFAB_ISOLATED !== "1";
const wakes = (appId: string, agentId: string, conversation: string) =>
  watchers.state(appId, agentId, conversation);
watchers.enabled = watches(config.rejoin);
service.rejoin.watchers = watchers.enabled ? wakes : null;
watchers.tidy();

const keychain = new Keychain(process.env, process.platform, undefined, {
  home,
});
// Only for an isolated server's own tests, and only on this computer.
const telegramStandIn =
  process.env.KONFAB_ISOLATED === "1" &&
  /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.KONFAB_TELEGRAM_TEST ?? "")
    ? process.env.KONFAB_TELEGRAM_TEST
    : undefined;
const phoneSetup = new PhoneSetup({
  home,
  keychain,
  client: (token) => new TelegramClient(token, telegramStandIn),
  changed: () => service.changed(),
});
// The same object all the time: it is read at every pass.
const noticeOptions = { ...config.phone_notices };
const notices = new TelegramNotices({
  db,
  home,
  options: noticeOptions,
  token: (place) => keychain.read(place),
  warn: (message) => app.log.warn(message),
});

/** Settings that a running server takes on. Open requests and calls are told. */
function applySettings(next: Config, before: Config): void {
  useConfig(next);
  Object.assign(noticeOptions, next.phone_notices);
  service.rejoin.wantedMs = next.rejoin.wanted_minutes * 60_000;
  const on = watches(next.rejoin);
  service.rejoin.watchers = on ? wakes : null;
  watchers.turn(on);
  if (before.rejoin.enabled && !next.rejoin.enabled) {
    rejoinReady = false;
    rejoinProblem = false;
    service.rejoin.turnedOff();
  } else if (watches(before.rejoin) && !on) service.rejoin.turnedOff("watch");
  if (
    before.rejoin.enabled !== next.rejoin.enabled ||
    before.rejoin.codex_command !== next.rejoin.codex_command ||
    before.rejoin.allow_untested_version !== next.rejoin.allow_untested_version
  ) {
    // Until the check of the new one is done, nothing is sent.
    rejoinReady = false;
    void checkRejoin();
  }
}

const app = await buildApp({
  notices,
  phoneSetup,
  sendRejoin: async (conversation, number) => {
    const result = await sendRejoin(rejoinCommand(), conversation, number);
    if (result === "refused") void checkRejoin();
    return result;
  },
  openApp: async (app) => opensApps() && (await openApp(app)),
  settings: { home, live, recheck: () => void checkRejoin() },
  watchers,
  service,
  skills,
  sources,
  skillsHome: home,
  port: config.server.port,
  webDir: resolve(import.meta.dirname, "../web"),
  logger: true,
  logStream: logFile,
});

const tick = setInterval(() => {
  service.tick();
  watchers.tidy();
}, config.server.tick_seconds * 1000);

// Apart from the rooms' own clock, which must not wait for it.
const noticesTick = setInterval(() => void notices.tick(), 15_000);

const shutdown = async (): Promise<void> => {
  clearInterval(tick);
  clearInterval(noticesTick);
  live.stop();
  await notices.settled();
  await sources.close();
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

void checkRejoin();
await app.listen({ host: "127.0.0.1", port: config.server.port });
live.start();
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
