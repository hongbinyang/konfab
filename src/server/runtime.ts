import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { lastUpgradeBackup, openDatabase, type Db } from "./db/index.js";
import { SkillLibrary } from "./domain/skills.js";
import { SkillSources, type SourceOptions } from "./domain/skill-sources.js";
import { KonfabService } from "./domain/service.js";

export interface Runtime {
  db: Db;
  service: KonfabService;
  skills: SkillLibrary;
  sources: SkillSources;
  /** The settings in use now; see serviceSettings. */
  useConfig: (config: Config) => void;
}

/** What the service reads when it needs it, so that a change is in use at once. */
export function serviceSettings(config: Config) {
  const { defaults } = config;
  return {
    maxConsecutiveAgentMessages: defaults.max_consecutive_agent_messages,
    parallelLeadMentions: defaults.parallel_lead_mentions,
    maxParallelLeadTurns: defaults.max_parallel_lead_turns,
    defaultCheckinMinutes: defaults.checkin_minutes,
    waitTimeoutSeconds: defaults.wait_timeout_seconds,
    turnTimeoutMs: defaults.turn_timeout_minutes * 60_000,
    autoContinueDelayMs: defaults.auto_continue_delay_seconds * 1000,
    maxMessageChars: defaults.max_message_chars,
    maxDecisionChars: defaults.max_decision_chars,
    runWarningsMinutes: defaults.run_warnings_minutes,
    maxAgentsPerApp: config.multi_agent.max_per_app,
    preApprovals: config.pre_approvals,
  };
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
  // The values that the running server takes on without a restart.
  let current = config;
  const service = new KonfabService(db, {
    ...serviceSettings(config),
    maxAttachmentBytes: config.defaults.max_attachment_mb * 1024 * 1024,
    attachmentDir: join(dirname(databaseFile), "files"),
    runHoursFor: (agentId) => {
      const owner = db
        .prepare("SELECT app_id FROM agents WHERE id=?")
        .get(agentId) as { app_id: string | null } | undefined;
      return (
        current.agents[agentId]?.run_hours ??
        current.agents[owner?.app_id ?? ""]?.run_hours ??
        current.defaults.run_hours
      );
    },
  });
  const useConfig = (next: Config) => {
    current = next;
    service.useSettings(serviceSettings(next));
    for (const [id, agent] of Object.entries(next.agents))
      service.ensureAgent(id, agent.display_name);
  };
  for (const [id, agent] of Object.entries(config.agents)) {
    service.ensureAgent(id, agent.display_name);
  }
  if (lastUpgradeBackup)
    console.error(
      `Konfab replaced roles with skills. A backup of the previous database is at ${lastUpgradeBackup}`,
    );
  const skills = new SkillLibrary(db);
  const builtinRoot = join(import.meta.dirname, "skills", "builtin");
  if (existsSync(builtinRoot)) skills.seedBuiltins(builtinRoot);
  return {
    db,
    service,
    useConfig,
    skills,
    sources: new SkillSources(db, {
      token: process.env.KONFAB_GITHUB_TOKEN,
      ...sourceOptions,
    }),
  };
}
