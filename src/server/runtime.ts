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
    parallelLeadMentions: config.defaults.parallel_lead_mentions,
    maxParallelLeadTurns: config.defaults.max_parallel_lead_turns,
    defaultCheckinMinutes: config.defaults.checkin_minutes,
    waitTimeoutSeconds: config.defaults.wait_timeout_seconds,
    turnTimeoutMs: config.defaults.turn_timeout_minutes * 60_000,
    autoContinueDelayMs: config.defaults.auto_continue_delay_seconds * 1000,
    maxMessageChars: config.defaults.max_message_chars,
    maxDecisionChars: config.defaults.max_decision_chars,
    maxAttachmentBytes: config.defaults.max_attachment_mb * 1024 * 1024,
    attachmentDir: join(dirname(databaseFile), "files"),
    runWarningsMinutes: config.defaults.run_warnings_minutes,
    runHoursFor: (agentId) => {
      const owner = db
        .prepare("SELECT app_id FROM agents WHERE id=?")
        .get(agentId) as { app_id: string | null } | undefined;
      return (
        config.agents[agentId]?.run_hours ??
        config.agents[owner?.app_id ?? ""]?.run_hours ??
        config.defaults.run_hours
      );
    },
    maxAgentsPerApp: config.multi_agent.max_per_app,
    preApprovals: config.pre_approvals,
  });
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
    skills,
    sources: new SkillSources(db, {
      token: process.env.KONFAB_GITHUB_TOKEN,
      ...sourceOptions,
    }),
  };
}
