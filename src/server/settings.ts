import { isDeepStrictEqual } from "node:util";
import { parseConfig, type Config } from "./config.js";

/**
 * Every setting in config.yaml, described once. The page, `npm run config`
 * and the table in the user guide come from this list. Limits are the
 * schema's own (config.ts); those here are for the page's fields, and a test
 * holds them together. See docs/design/settings.md.
 */
export type Value = string | number | boolean | null | object;

export type Control =
  | { type: "switch" }
  | { type: "number"; min: number; max: number; unit?: string }
  | { type: "time" }
  | { type: "command" }
  /** Only on the command line, as YAML. */
  | { type: "text" };

export type Setting = {
  key: string;
  section: "phone" | "rejoin" | "agents" | "advanced";
  name: string;
  help: string;
  control: Control;
  /** When a change is in use. */
  effect: "now" | "next_join" | "restart" | "next_setup" | "never";
  /** In the page: with its own field, with its own steps, or not yet. */
  page: "edit" | "ask" | "later" | "no";
};

const whole = (min: number, max: number, unit?: string): Control => ({
  type: "number",
  min,
  max,
  ...(unit ? { unit } : {}),
});
const on: Control = { type: "switch" };
const text: Control = { type: "text" };

type Short = [
  key: string,
  name: string,
  help: string,
  control: Control,
  effect?: Setting["effect"],
  page?: Setting["page"],
];
const group = (
  section: Setting["section"],
  prefix: string,
  effect: Setting["effect"],
  page: Setting["page"],
  rows: Short[],
): Setting[] =>
  rows.map(([key, name, help, control, own, ownPage]) => ({
    key: `${prefix}.${key}`,
    section,
    name,
    help,
    control,
    effect: own ?? effect,
    page: ownPage ?? page,
  }));

export const SETTINGS: Setting[] = [
  ...group("phone", "phone_notices", "now", "edit", [
    [
      "away_minutes",
      "Away after",
      "Minutes without activity before phone notices are sent",
      whole(1, 1440, "min"),
    ],
    [
      "quiet_from",
      "Quiet from",
      "Start of quiet hours, such as 22:00; nothing is sent in them (needs both times)",
      { type: "time" },
    ],
    [
      "quiet_to",
      "Quiet until",
      "End of quiet hours, such as 07:30",
      { type: "time" },
    ],
    [
      "room_names",
      "Name the room",
      "Whether phone notices name the room, which Telegram then sees",
      on,
    ],
    [
      "room_every_minutes",
      "Per room, at most every",
      "Minutes between two notices about the same room",
      whole(1, 1440, "min"),
    ],
    [
      "max_per_day",
      "At most a day",
      "Phone notices per day",
      whole(1, 200, "a day"),
    ],
  ]),
  ...group("rejoin", "rejoin", "now", "edit", [
    [
      "enabled",
      "Rejoin buttons",
      "Whether agents can be asked to rejoin; off closes requests that are open",
      on,
    ],
    [
      "claude_watcher",
      "Wake Claude agents",
      "Asks Claude agents, when they join, to start one small background command that wakes them",
      on,
      "next_join",
    ],
    [
      "open_apps",
      "Open the apps on a click",
      "Lets a button bring Codex or Claude to the front (macOS)",
      on,
    ],
    [
      "wanted_minutes",
      "A request is wanted for",
      "How long a request to rejoin stays wanted",
      whole(1, 60, "min"),
    ],
    [
      "allow_untested_version",
      "Untried Codex versions",
      "Use a Codex version this hasn't been tried with",
      on,
      "now",
      "ask",
    ],
    [
      "codex_command",
      "Codex command",
      "Absolute path of the Codex command, instead of the app's own copy; its signature isn't required",
      { type: "command" },
      "now",
      "ask",
    ],
  ]),
  ...group("agents", "defaults", "restart", "later", [
    [
      "run_hours",
      "Run window",
      "Usable hours per agent session (also per agent under agents)",
      whole(0, 24, "h"),
    ],
    [
      "run_warnings_minutes",
      "Run-window warnings",
      "When run-window warnings appear",
      text,
    ],
    [
      "max_consecutive_agent_messages",
      "Agent messages in a row",
      "Agent messages in a row before the room waits for you",
      whole(1, 100_000),
    ],
    [
      "parallel_lead_mentions",
      "Parallel answers in new rooms",
      "Parallel answers to your mentions in new rooms",
      on,
    ],
    [
      "max_parallel_lead_turns",
      "Parallel turns",
      "Parallel turns per room",
      whole(1, 10),
    ],
    [
      "checkin_minutes",
      "Check-in interval",
      "Busy-agent check-in interval (1, 2, 5 or 10)",
      whole(1, 10, "min"),
    ],
    [
      "wait_timeout_seconds",
      "Wait call",
      "How long a waiting agent's call lasts; longer uses less allowance",
      whole(1, 100_000, "s"),
    ],
    [
      "turn_timeout_minutes",
      "Silent turn",
      "When a silent turn is flagged and recovered",
      whole(1, 100_000, "min"),
    ],
    [
      "auto_continue_delay_seconds",
      "Automatic continuation after",
      "Delay before automatic continuation",
      whole(10, 3600, "s"),
    ],
    [
      "max_message_chars",
      "Longest message",
      "Characters in a message",
      whole(1, 1_000_000),
    ],
    [
      "max_decision_chars",
      "Longest decision",
      "Characters in a decision",
      whole(1, 1_000_000),
    ],
    [
      "max_attachment_mb",
      "Largest attachment",
      "Largest attachment",
      whole(1, 100, "MB"),
    ],
  ]),
  ...group("agents", "multi_agent", "restart", "later", [
    ["max_per_app", "Agents per app", "Agents per desktop app", whole(1, 100)],
  ]),
  ...group("advanced", "server", "restart", "later", [
    [
      "port",
      "Port",
      "Port for the page and the connectors; run setup again after a change",
      whole(1024, 65535),
    ],
    [
      "tick_seconds",
      "Clock",
      "How often the server looks for timeouts",
      whole(1, 60, "s"),
    ],
  ]),
  {
    key: "connectors.install",
    section: "advanced",
    name: "Connector setup",
    help: "manual makes setup write instructions instead of editing apps",
    control: text,
    effect: "next_setup",
    page: "later",
  },
  {
    key: "agents",
    section: "advanced",
    name: "Agents",
    help: "Agents that are made at the start, with their names and run hours",
    control: text,
    effect: "restart",
    page: "no",
  },
  {
    key: "pre_approvals",
    section: "advanced",
    name: "Pre-approvals",
    help: "Actions agents may take without asking (still logged)",
    control: text,
    effect: "restart",
    page: "later",
  },
  {
    key: "defaults.hours",
    section: "advanced",
    name: "Hours",
    help: "Not used any more",
    control: text,
    effect: "never",
    page: "no",
  },
];

const AGENT = /^agents\.([a-z][a-z0-9_-]*)(\.(display_name|run_hours|hours))?$/;

/** A setting, or one of a single agent's. */
export function settingFor(key: string): Setting | null {
  const found = SETTINGS.find((setting) => setting.key === key);
  if (found) return found;
  if (!AGENT.test(key)) return null;
  return {
    ...SETTINGS.find((setting) => setting.key === "agents")!,
    key,
    effect: key.endsWith(".hours") ? "never" : "restart",
  };
}

export const pathOf = (key: string): string[] => key.split(".");

export function valueAt(config: unknown, key: string): Value | undefined {
  let at = config;
  for (const part of pathOf(key)) {
    if (typeof at !== "object" || at === null || !Object.hasOwn(at, part))
      return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at as Value | undefined;
}

const DEFAULTS: Config = parseConfig("");

export const defaultOf = (key: string): Value | undefined =>
  valueAt(DEFAULTS, key);

/** The parts that a running server takes on by itself. */
export const LIVE = ["phone_notices", "rejoin"] as const;

/** What differs between the file and what is in use. */
export function notInUse(saved: Config, inUse: Config): string[] {
  return SETTINGS.filter(
    ({ key, effect }) =>
      effect === "restart" &&
      !isDeepStrictEqual(valueAt(saved, key), valueAt(inUse, key)),
  ).map(({ key }) => key);
}

export const EFFECT: Record<Setting["effect"], string> = {
  now: "At once",
  next_join: "From the next join",
  restart: "After a restart of Konfab",
  next_setup: "At the next setup",
  never: "Not used",
};

/** In words: for the command line, the page and the guide. */
export function shown(value: Value | undefined): string {
  if (value === undefined || value === null) return "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
