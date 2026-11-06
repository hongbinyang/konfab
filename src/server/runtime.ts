import { chmodSync, existsSync } from "node:fs";
import type { Config } from "./config.js";
import { openDatabase, type Db } from "./db/index.js";
import { KonfabService } from "./domain/service.js";

export interface Runtime {
  db: Db;
  service: KonfabService;
}

export function createRuntime(databaseFile: string, config: Config): Runtime {
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
    maxMessageChars: config.defaults.max_message_chars,
    hoursFor: (agentId) =>
      config.agents[agentId]?.hours ?? config.defaults.hours,
    preApprovals: config.pre_approvals,
  });
  for (const [id, agent] of Object.entries(config.agents)) {
    service.ensureAgent(id, agent.display_name);
  }
  return { db, service };
}
