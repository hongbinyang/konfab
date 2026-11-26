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
  | {
      type: "number";
      min: number;
      max: number;
      unit?: string;
      /** Not only whole numbers, such as 1.5 hours. */
      decimal?: boolean;
    }
  | { type: "time" }
  | { type: "command" }
  /** A short name. */
  | { type: "name" }
  /** Pre-approvals, added and removed one at a time, each after its question. */
  | { type: "approvals" }
  /** Minutes, such as "30, 10, 5". */
  | { type: "minutes"; max: number; most: number }
  /** Only on the command line, as YAML. */
  | { type: "text" };

export type Setting = {
  key: string;
  section: "phone" | "rejoin" | "agents" | "approvals" | "advanced";
  name: string;
  help: string;
  control: Control;
  /** When a change is in use. */
  effect: "now" | "next_join" | "restart" | "next_setup" | "never";
  /** In the page: with its own field, with its own steps, or not yet. */
  page: "edit" | "ask" | "later" | "no";
};

const whole = (
  min: number,
  max: number,
  unit?: string,
  decimal?: boolean,
): Control => ({
  type: "number",
  min,
  max,
  ...(unit ? { unit } : {}),
  ...(decimal ? { decimal } : {}),
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
  ...group("agents", "defaults", "now", "edit", [
    [
      "run_hours",
      "Run window",
      "Usable hours per agent session; an agent's own comes first",
      whole(1, 24, "h", true),
      "next_join",
    ],
    [
      "run_warnings_minutes",
      "Run-window warnings",
      "Minutes before the end of a run window when a warning appears",
      { type: "minutes", max: 1440, most: 20 },
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
      "Busy-agent check-in interval (1, 2, 5 or 10); a room's own comes first",
      whole(1, 10, "min"),
    ],
    [
      "wait_timeout_seconds",
      "Wait call",
      "How long a waiting agent's call lasts; longer uses less allowance. Agents are told at their next join",
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
      "restart",
    ],
  ]),
  ...group("agents", "multi_agent", "now", "edit", [
    ["max_per_app", "Agents per app", "Agents per desktop app", whole(1, 100)],
  ]),
  ...group("advanced", "server", "restart", "edit", [
    [
      "port",
      "Port",
      "Port for the page and the connectors; run setup again after a change",
      whole(1024, 65535),
      "restart",
      "ask",
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
    help: "The apps that connectors join as, with their names and run hours",
    control: text,
    effect: "now",
    page: "no",
  },
  {
    key: "pre_approvals",
    section: "approvals",
    name: "Pre-approvals",
    help: "What agents may send to whom without asking you; each use is still logged",
    control: { type: "approvals" },
    effect: "now",
    page: "edit",
  },
];

const AGENT = /^agents\.([a-z][a-z0-9_-]*)(\.(display_name|run_hours))?$/;

/** A setting, or one of a single agent's. */
export function settingFor(key: string): Setting | null {
  const found = SETTINGS.find((setting) => setting.key === key);
  if (found) return found;
  if (!AGENT.test(key)) return null;
  return {
    ...SETTINGS.find((setting) => setting.key === "agents")!,
    key,
    ...(key.endsWith(".run_hours")
      ? {
          name: "Run window",
          help: "Usable hours per session of this agent; empty means the default",
          control: whole(1, 24, "h", true),
          effect: "next_join" as const,
          page: "edit" as const,
        }
      : key.endsWith(".display_name")
        ? {
            name: "Name",
            help: "Shown in the page",
            control: { type: "name" as const },
            effect: "now" as const,
            page: "edit" as const,
          }
        : {}),
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

/**
 * An agent in the file needs its name; one that comes only from the defaults
 * gets it written along, as it is.
 */
export function withName(
  set: Record<string, Value>,
  config: Config,
): Record<string, Value> {
  const more: Record<string, Value> = {};
  for (const key of Object.keys(set)) {
    const id = /^agents\.([^.]+)\.run_hours$/.exec(key)?.[1];
    const name = id && config.agents[id]?.display_name;
    if (name && !(`agents.${id}.display_name` in set))
      more[`agents.${id}.display_name`] = name;
  }
  return { ...more, ...set };
}

export type Approval = { recipient: string; data: string };

/** As requests are matched against it. */
const plain = (text: string) => text.trim().toLowerCase();
export const sameApproval = (one: Approval, other: Approval) =>
  plain(one.recipient) === plain(other.recipient) &&
  plain(one.data) === plain(other.data);

/** The same on both paths; a reason if it isn't one. */
export function approvalProblem(approval: Approval): string | null {
  for (const [what, text] of [
    ["recipient", approval.recipient],
    ["kind of data", approval.data],
  ] as const) {
    if (!text.trim()) return `The ${what} is empty`;
    if (text.length > 200) return `The ${what} is longer than 200 characters`;
    if ([...text].some((char) => char < " " || char === "\u007f"))
      return `The ${what} has a line break or another control character`;
  }
  return null;
}

/** Says exactly what is matched, and for how long. */
export const approvalQuestion = ({ recipient, data }: Approval): string =>
  `From now on, agents may send ${data.trim()} to ${recipient.trim()} without asking you, in every room and in every future request, until you remove it. Each use is still logged. Allow it?`;

/**
 * Adds or removes one entry, on the list as it is in the file then. Other
 * entries stay as they are.
 */
export const approvalChange =
  (approval: Approval, add: boolean) =>
  (config: Config): { set: Record<string, Value> } => {
    const list = config.pre_approvals;
    const there = list.some((one) => sameApproval(one, approval));
    if (add === there) return { set: {} };
    return {
      set: {
        pre_approvals: add
          ? [
              ...list,
              {
                recipient: approval.recipient.trim(),
                data: approval.data.trim(),
              },
            ]
          : list.filter((one) => !sameApproval(one, approval)),
      },
    };
  };

/**
 * Keys in the file that nothing reads, such as those of earlier versions.
 * They are left alone until the lead removes them.
 */
export function unusedKeys(file: unknown): string[] {
  if (typeof file !== "object" || file === null || Array.isArray(file))
    return [];
  const known = SETTINGS.map(({ key }) => key);
  const inside = (path: string) =>
    known.some((key) => key.startsWith(`${path}.`));
  const unused: string[] = [];
  const walk = (value: unknown, at: string) => {
    for (const [name, inner] of Object.entries(value as object)) {
      const path = at ? `${at}.${name}` : name;
      if (at === "agents") {
        // An agent: its own keys only.
        if (typeof inner !== "object" || inner === null) continue;
        for (const field of Object.keys(inner))
          if (!settingFor(`${path}.${field}`)) unused.push(`${path}.${field}`);
      } else if (path === "agents") {
        if (typeof inner === "object" && inner !== null) walk(inner, path);
      } else if (known.includes(path)) continue;
      else if (inside(path) && typeof inner === "object" && inner !== null)
        walk(inner, path);
      else if (!known.includes(path)) unused.push(path);
    }
  };
  walk(file, "");
  return unused;
}

/** Whether a running server takes it on by itself. */
export const isLive = (setting: Pick<Setting, "effect">): boolean =>
  setting.effect === "now" || setting.effect === "next_join";

/**
 * Asked before a change that can end something at once, or cut off the page.
 * Null: nothing to ask.
 */
export function questionFor(
  key: string,
  saved: Value | undefined,
  next: Value | undefined,
): string | null {
  if (
    key === "defaults.turn_timeout_minutes" &&
    typeof next === "number" &&
    typeof saved === "number" &&
    next < saved
  )
    return `A silent turn that is already longer than ${next} minutes is ended at the next look. Shorten it?`;
  if (key === "server.port" && next !== saved)
    return `Used after the next restart of Konfab. The page is then at http://127.0.0.1:${shown(next)}, and both apps need \`npm run setup\` once; until then their agents can't reach Konfab. Change it?`;
  return null;
}

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
