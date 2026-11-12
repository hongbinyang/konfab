import { resolve } from "node:path";
import { buildApp } from "./api/app.js";
import { databasePath, ensureHome, konfabHome, loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { resolveGithubToken } from "./github-token.js";

const home = konfabHome();
ensureHome(home);
const config = loadConfig(home);
const { db, service, skills, sources, roles } = createRuntime(
  databasePath(home),
  config,
  (() => {
    const resolved = resolveGithubToken(process.env.KONFAB_GITHUB_TOKEN);
    return { token: resolved.token, tokenSource: resolved.source };
  })(),
);
service.recoverAfterRestart();
service.recoverDeletedRooms();

const app = await buildApp({
  service,
  skills,
  sources,
  roles,
  skillsHome: home,
  rolePicker: config.ui.role_picker,
  port: config.server.port,
  webDir: resolve(import.meta.dirname, "../web"),
  logger: true,
});

const tick = setInterval(
  () => service.tick(),
  config.server.tick_seconds * 1000,
);

const shutdown = async (): Promise<void> => {
  clearInterval(tick);
  await sources.close();
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: "127.0.0.1", port: config.server.port });

// Printed directly, so the one-time code stays out of the structured logs.
console.log(
  `\nSign in to Konfab: http://127.0.0.1:${config.server.port}/login?code=${service.createLoginCode()}\n`,
);
