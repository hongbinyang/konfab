import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const configSchema = z.object({
  server: z
    .object({ port: z.number().int().min(1024).max(65535).default(8787) })
    .default({
      port: 8787,
    }),
  room: z
    .object({
      name: z.string().min(1).default("test"),
      topic: z.string().default("Phase 0 connection test"),
    })
    .default({ name: "test", topic: "Phase 0 connection test" }),
  defaults: z
    .object({
      max_consecutive_agent_messages: z.number().int().min(1).default(5),
      wait_timeout_seconds: z.number().int().min(1).default(50),
      turn_timeout_minutes: z.number().int().min(1).default(30),
      max_message_chars: z.number().int().min(1).default(20000),
    })
    .default({
      max_consecutive_agent_messages: 5,
      wait_timeout_seconds: 50,
      turn_timeout_minutes: 30,
      max_message_chars: 20000,
    }),
  agents: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]*$/),
      z.object({ display_name: z.string().min(1) }),
    )
    .default({
      claude: { display_name: "Claude" },
      codex: { display_name: "Codex" },
    }),
});

export type Config = z.infer<typeof configSchema>;

const DEFAULT_CONFIG = `server:
  port: 8787

room:
  name: test
  topic: Phase 0 connection test

defaults:
  max_consecutive_agent_messages: 5
  wait_timeout_seconds: 50
  turn_timeout_minutes: 30
  max_message_chars: 20000

agents:
  claude:
    display_name: Claude
  codex:
    display_name: Codex
`;

export function konfabHome(): string {
  return process.env.KONFAB_HOME ?? join(homedir(), ".konfab");
}

export function databasePath(home: string): string {
  return join(home, "konfab.db");
}

export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const configPath = join(home, "config.yaml");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, DEFAULT_CONFIG, { mode: 0o600 });
  }
}

export function loadConfig(home: string): Config {
  return configSchema.parse(
    parse(readFileSync(join(home, "config.yaml"), "utf8")) ?? {},
  );
}
