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
import { DAY_NAMES } from "./domain/hours.js";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

const hoursSchema = z.object({
  start: time,
  end: time,
  days: z.array(z.enum(DAY_NAMES)).min(1),
});

const ALL_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DEFAULT_HOURS = {
  start: "09:00",
  end: "18:00",
  days: [...ALL_DAYS],
};

const defaultsSchema = z.object({
  hours: hoursSchema.default(DEFAULT_HOURS),
  run_hours: z.number().positive().max(24).default(5),
  run_warnings_minutes: z
    .array(z.number().positive().max(1440))
    .max(20)
    .default([30, 10, 5]),
  max_consecutive_agent_messages: z.number().int().min(1).default(50),
  wait_timeout_seconds: z.number().int().min(1).default(50),
  turn_timeout_minutes: z.number().int().min(1).default(30),
  auto_continue_delay_seconds: z.number().int().min(10).max(3600).default(180),
  max_message_chars: z.number().int().min(1).default(20000),
  max_decision_chars: z.number().int().min(1).default(4000),
  max_attachment_mb: z.number().int().min(1).max(100).default(10),
});

const configSchema = z.object({
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
        hours: hoursSchema.optional(),
        run_hours: z.number().positive().max(24).optional(),
      }),
    )
    .default({
      claude: { display_name: "Claude" },
      codex: { display_name: "Codex" },
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
