import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { openDatabase, type Db } from "./db/index.js";
import { SkillLibrary } from "./domain/skills.js";
import { SkillSources, type SourceOptions } from "./domain/skill-sources.js";
import { RoleLibrary } from "./domain/roles.js";
import { KonfabService } from "./domain/service.js";

export interface Runtime {
  db: Db;
  service: KonfabService;
  skills: SkillLibrary;
  sources: SkillSources;
  roles: RoleLibrary;
}

export function createRuntime(
  databaseFile: string,
  config: Config,
  sourceOptions: SourceOptions = {},
): Runtime {
  const db = openDatabase(databaseFile);
  for (const file of [
    databaseFile,
    `${databaseFile}-wal`,
    `${databaseFile}-shm`,
  ]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
  const service = new KonfabService(db, {
    maxConsecutiveAgentMessages: config.defaults.max_consecutive_agent_messages,
    waitTimeoutSeconds: config.defaults.wait_timeout_seconds,
    turnTimeoutMs: config.defaults.turn_timeout_minutes * 60_000,
    autoContinueDelayMs: config.defaults.auto_continue_delay_seconds * 1000,
    maxMessageChars: config.defaults.max_message_chars,
    maxDecisionChars: config.defaults.max_decision_chars,
    maxAttachmentBytes: config.defaults.max_attachment_mb * 1024 * 1024,
    attachmentDir: join(dirname(databaseFile), "files"),
    runWarningsMinutes: config.defaults.run_warnings_minutes,
    runHoursFor: (agentId) =>
      config.agents[agentId]?.run_hours ?? config.defaults.run_hours,
    preApprovals: config.pre_approvals,
  });
  for (const [id, agent] of Object.entries(config.agents)) {
    service.ensureAgent(id, agent.display_name);
  }
  const roles = new RoleLibrary(db);
  const builtinRoot = join(import.meta.dirname, "roles", "builtin");
  if (existsSync(builtinRoot)) roles.seedBuiltins(builtinRoot);
  db.prepare(
    "INSERT OR IGNORE INTO role_libraries(id, kind, root_path) VALUES ('personal', 'personal', ?)",
  ).run(join(dirname(databaseFile), "roles"));
  return {
    db,
    service,
    skills: new SkillLibrary(db),
    sources: new SkillSources(db, {
      cacheBytes: config.defaults.source_cache_mb * 1024 * 1024,
      token: process.env.KONFAB_GITHUB_TOKEN,
      ...sourceOptions,
    }),
    roles,
  };
}
