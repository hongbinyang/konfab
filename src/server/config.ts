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
// Keys that nothing reads any more (such as hours) are dropped when the
// file is read, and stay in the file until the lead cleans it up.
const defaultsSchema = z.object({
  run_hours: z.number().positive().max(24).default(5),
  run_warnings_minutes: z
    .array(z.number().positive().max(1440))
    .max(20)
    .default([30, 10, 5]),
  max_consecutive_agent_messages: z.number().int().min(1).default(50),
  parallel_lead_mentions: z.boolean().default(false),
  max_parallel_lead_turns: z.number().int().min(1).max(10).default(3),
  checkin_minutes: z
    .union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)])
    .default(2),
  wait_timeout_seconds: z.number().int().min(1).default(50),
  turn_timeout_minutes: z.number().int().min(1).default(30),
  auto_continue_delay_seconds: z.number().int().min(10).max(3600).default(180),
  max_message_chars: z.number().int().min(1).default(20000),
  max_decision_chars: z.number().int().min(1).default(4000),
  max_attachment_mb: z.number().int().min(1).max(100).default(10),
});

const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 22:00");

const configSchema = z.object({
  multi_agent: z
    .object({ max_per_app: z.number().int().min(1).max(100).default(4) })
    .default({ max_per_app: 4 }),
  connectors: z
    .object({ install: z.enum(["user", "manual"]).default("user") })
    .default({ install: "user" }),
  server: z
    .object({
      port: z.number().int().min(1024).max(65535).default(8787),
      tick_seconds: z.number().int().min(1).max(60).default(30),
    })
    .default({ port: 8787, tick_seconds: 30 }),
  defaults: defaultsSchema.default(() => defaultsSchema.parse({})),
  agents: z
    .record(
      z
        .string()
        .regex(/^[a-z][a-z0-9_-]*$/)
        .refine((name) => !["lead", "all", "user"].includes(name), {
          message: "This agent name is reserved",
        }),
      z.object({
        display_name: z.string().min(1),
        run_hours: z.number().positive().max(24).optional(),
      }),
    )
    .default({
      claude: { display_name: "Claude" },
      codex: { display_name: "Codex" },
    }),
  phone_notices: z
    .object({
      away_minutes: z.number().int().min(1).max(1440).default(10),
      quiet_from: clock.nullable().default(null),
      quiet_to: clock.nullable().default(null),
      room_names: z.boolean().default(false),
      message_text: z.boolean().default(true),
      room_every_minutes: z.number().int().min(1).max(1440).default(10),
      max_per_day: z.number().int().min(1).max(200).default(20),
    })
    .default({
      away_minutes: 10,
      quiet_from: null,
      quiet_to: null,
      room_names: false,
      message_text: true,
      room_every_minutes: 10,
      max_per_day: 20,
    }),
  rejoin: z
    .object({
      enabled: z.boolean().default(true),
      wanted_minutes: z.number().int().min(1).max(60).default(10),
      codex_command: z.string().min(1).nullable().default(null),
      allow_untested_version: z.boolean().default(false),
      claude_watcher: z.boolean().default(false),
      open_apps: z.boolean().default(true),
    })
    .default({
      enabled: true,
      wanted_minutes: 10,
      codex_command: null,
      allow_untested_version: false,
      claude_watcher: false,
      open_apps: true,
    }),
  pre_approvals: z
    .array(z.object({ recipient: z.string().min(1), data: z.string().min(1) }))
    .default([]),
});

export type Config = z.infer<typeof configSchema>;

const DEFAULT_CONFIG = `server:
  port: 8787

defaults:
  run_hours: 5
  run_warnings_minutes: [30, 10, 5]
  max_consecutive_agent_messages: 50
  checkin_minutes: 2
  wait_timeout_seconds: 50
  turn_timeout_minutes: 30
  auto_continue_delay_seconds: 180
  max_message_chars: 20000
  max_decision_chars: 4000
  max_attachment_mb: 10

agents:
  claude:
    display_name: Claude
  codex:
    display_name: Codex

# Actions agents may take without asking. Each one is still logged.
pre_approvals: []
#  - recipient: github.com/OWNER/REPO
#    data: code_push
`;

export function konfabHome(): string {
  return process.env.KONFAB_HOME ?? join(homedir(), ".konfab");
}

export function configPath(home: string): string {
  return join(home, "config.yaml");
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
  return parseConfig(readFileSync(join(home, "config.yaml"), "utf8"));
}

export function parseConfig(text: string): Config {
  return configSchema.parse(parse(text) ?? {});
}
