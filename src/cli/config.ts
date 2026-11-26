import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { ensureHome, konfabHome, type Config } from "../server/config.js";
import { readInUse } from "../server/live-settings.js";
import { agree, lookAtOwn } from "../server/rejoin/own-command.js";
import {
  changeSettings,
  checked,
  readSettingsFile,
  SettingsError,
} from "../server/settings-file.js";
import {
  approvalChange,
  approvalProblem,
  approvalQuestion,
  defaultOf,
  EFFECT,
  questionFor,
  SETTINGS,
  settingFor,
  shown,
  unusedKeys,
  valueAt,
  withName,
  type Setting,
  type Value,
} from "../server/settings.js";

const USAGE = `Usage:
  npm run config                         all settings
  npm run config -- get <setting>
  npm run config -- set <setting> <value>
  npm run config -- reset <setting>
  npm run config -- approve <recipient> <data>      agents may send it without asking
  npm run config -- unapprove <recipient> <data>
  npm run config -- clean                removes keys that nothing reads any more
  --yes                                  says yes to a question, without a terminal`;
const COMMAND = "rejoin.codex_command";

export type ConfigDeps = {
  home: string;
  say: (line: string) => void;
  /** Null where nobody can be asked. */
  ask: ((question: string) => Promise<string>) | null;
  sleep: (ms: number) => Promise<void>;
  waitMs: number;
  inUse: typeof readInUse;
  look: typeof lookAtOwn;
};

const at = (config: Config, key: string) => valueAt(config, key) as Value;

function row(config: Config, setting: Setting, waiting: string[]): string {
  const value = valueAt(config, setting.key);
  const usual = defaultOf(setting.key);
  return [
    `${setting.key}: ${shown(value)}`,
    isDeepStrictEqual(value, usual) ? "" : `(default: ${shown(usual)})`,
    waiting.includes(setting.key) ? "· not in use before a restart" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Whether the running server of this folder has taken on this file. */
async function inUseText(
  deps: ConfigDeps,
  setting: Setting,
  hash: string,
): Promise<string> {
  if (setting.effect === "never") return "Saved. Nothing uses it.";
  if (setting.effect === "next_setup") return "Saved. Used at the next setup.";
  const until = Date.now() + deps.waitMs;
  for (;;) {
    const note = deps.inUse(deps.home);
    if (note === "none")
      return "Saved. Konfab isn't running from this folder; used at the next start.";
    if (note !== "unsure" && note.hash === hash) {
      if (note.problem) return `Saved, but not in use: ${note.problem}`;
      if (note.waiting.includes(setting.key))
        return `Saved. The running Konfab (port ${note.port}) uses it after a restart.`;
      return setting.effect === "next_join"
        ? "In use. An agent takes part from its next join; paste its rejoin prompt once."
        : "In use.";
    }
    if (Date.now() >= until)
      return "Saved. The running Konfab hasn't confirmed it; it may be busy, or need a restart.";
    await deps.sleep(250);
  }
}

export async function runConfig(
  args: string[],
  deps: ConfigDeps,
): Promise<number> {
  const { home, say } = deps;
  const yes = args.includes("--yes");
  const [action = "list", key, ...rest] = args.filter((arg) => arg !== "--yes");
  const read = () => {
    const file = readSettingsFile(home);
    return { ...file, config: checked(file.text) };
  };
  try {
    if (action === "list" && key === undefined) {
      const { config } = read();
      const note = deps.inUse(home);
      const waiting = typeof note === "string" ? [] : note.waiting;
      for (const setting of SETTINGS) say(row(config, setting, waiting));
      const unused = unusedKeys(parse(read().text));
      if (unused.length)
        say(
          `\nNot used any more: ${unused.join(", ")}. \`npm run config -- clean\` removes them.`,
        );
      if (note === "unsure")
        say("\nWhat the running Konfab uses isn't known now.");
      else if (note !== "none" && note.problem)
        say(`\nNot in use: ${note.problem}`);
      return 0;
    }
    if (action === "clean" && key === undefined) {
      const unused = unusedKeys(parse(read().text));
      if (!unused.length) {
        say("Nothing to clean up.");
        return 0;
      }
      say(
        `Not used any more: ${unused.join(", ")}. A copy of the file is kept in backups/config.`,
      );
      if (!yes) {
        if (!deps.ask) {
          say("Not changed: this needs your yes in a terminal, or --yes.");
          return 1;
        }
        if (!/^y(es)?$/i.test((await deps.ask("Remove them? [y/N] ")).trim())) {
          say("Not changed.");
          return 1;
        }
      }
      const done = await changeSettings(home, { drop: "unused" });
      say(done.changed ? "Removed." : "Nothing to clean up.");
      return 0;
    }
    if (action === "approve" || action === "unapprove")
      return await approve(deps, action === "approve", yes, key, rest);
    const setting = key === undefined ? null : settingFor(key);
    if (!["get", "set", "reset"].includes(action) || key === undefined) {
      say(USAGE);
      return 2;
    }
    if (!setting) {
      say(`${key} isn't a setting. \`npm run config\` shows them all.`);
      return 2;
    }
    if (action === "get" && rest.length === 0) {
      const { config } = read();
      const note = deps.inUse(home);
      say(row(config, setting, typeof note === "string" ? [] : note.waiting));
      say(`${setting.help}. ${EFFECT[setting.effect]}.`);
      return 0;
    }
    if (action === "set" ? rest.length !== 1 : rest.length !== 0) {
      say(USAGE);
      return 2;
    }
    // Each entry has its own question.
    if (action === "set" && setting.control.type === "approvals") {
      say("Use `approve` and `unapprove`, one entry at a time.");
      return 2;
    }
    const before = read();
    let value: Value | undefined;
    let agreed: { path: string; stamp: string } | null = null;
    if (action === "set") {
      try {
        value = parse(rest[0]!) as Value;
      } catch {
        throw new SettingsError("invalid", "the value can't be read", key);
      }
      // A time such as 22:00 is text; YAML may read it as something else.
      if (setting.control.type === "time" || setting.control.type === "command")
        value = /^(none|null)$/.test(rest[0]!) ? null : rest[0]!;
      // Such as 30,10,5 or "30, 10, 5".
      if (setting.control.type === "minutes" && typeof value !== "object")
        value = String(rest[0])
          .split(",")
          .map((part) => (/^\s*\d+\s*$/.test(part) ? Number(part) : part));
      if (key === COMMAND && typeof value === "string") {
        const look = await deps.look(value, home);
        if (!look.ok) {
          say(`Not changed: ${look.reason}.`);
          return 1;
        }
        say(
          `Konfab will run ${look.path} as you. ${look.signed_by ? `It says it is signed by ${look.signed_by}, which is something to go by, not a guarantee.` : "It isn't signed, as far as can be seen."}`,
        );
        if (!deps.ask) {
          say("Not changed: this needs your yes in a terminal.");
          return 1;
        }
        if (!/^y(es)?$/i.test((await deps.ask("Use it? [y/N] ")).trim())) {
          say("Not changed.");
          return 1;
        }
        value = look.path;
        agreed = { path: look.path, stamp: look.stamp };
      }
    }
    const question = questionFor(
      key,
      at(before.config, key),
      action === "set" ? value : defaultOf(key),
    );
    if (question && !yes) {
      say(question.replace(/\?$/, "."));
      if (!deps.ask) {
        say("Not changed: this needs your yes in a terminal, or --yes.");
        return 1;
      }
      if (!/^y(es)?$/i.test((await deps.ask("Go on? [y/N] ")).trim())) {
        say("Not changed.");
        return 1;
      }
    }
    const done = await changeSettings(
      home,
      action === "set"
        ? { set: withName({ [key]: value! }, before.config) }
        : { reset: [key] },
      before.hash,
    );
    if (key === COMMAND) agree(home, agreed);
    const [old, now] = [at(before.config, key), at(done.config, key)];
    say(
      isDeepStrictEqual(old, now)
        ? `${key}: ${shown(now)}${done.changed ? "" : ", as before"}`
        : `${key}: ${shown(old)} → ${shown(now)}`,
    );
    say(await inUseText(deps, setting, done.hash));
    return 0;
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    say(`Not changed: ${error.message}.`);
    if (error.code === "invalid" && helpOf(key)) say(helpOf(key)!);
    return 1;
  }
}

/** One entry, on the list as it is then; adding it only after the question. */
async function approve(
  deps: ConfigDeps,
  add: boolean,
  yes: boolean,
  recipient: string | undefined,
  rest: string[],
): Promise<number> {
  const { say } = deps;
  if (recipient === undefined || rest.length !== 1) {
    say(USAGE);
    return 2;
  }
  const approval = { recipient, data: rest[0]! };
  const problem = approvalProblem(approval);
  if (problem) {
    say(`Not changed: ${problem}.`);
    return 1;
  }
  if (add && !yes) {
    say(approvalQuestion(approval).replace(/ Allow it\?$/, ""));
    if (!deps.ask) {
      say("Not changed: this needs your yes in a terminal, or --yes.");
      return 1;
    }
    if (!/^y(es)?$/i.test((await deps.ask("Allow it? [y/N] ")).trim())) {
      say("Not changed.");
      return 1;
    }
  }
  const done = await changeSettings(deps.home, approvalChange(approval, add));
  say(
    done.changed
      ? `${add ? "Added" : "Removed"}: ${approval.data.trim()} to ${approval.recipient.trim()}.`
      : add
        ? "It was there already."
        : "It wasn't there.",
  );
  say(await inUseText(deps, settingFor("pre_approvals")!, done.hash));
  return 0;
}

function helpOf(key: string | undefined): string | null {
  const setting = key ? settingFor(key) : null;
  return setting ? `${setting.help}.` : null;
}

if (process.argv[1]?.endsWith("cli/config.js")) {
  const home = konfabHome();
  ensureHome(home);
  const person = process.stdin.isTTY && process.stdout.isTTY;
  const ask = async (question: string) => {
    const lines = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await lines.question(question);
    } finally {
      lines.close();
    }
  };
  process.exitCode = await runConfig(process.argv.slice(2), {
    home,
    say: (line) => console.log(line),
    ask: person ? ask : null,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    waitMs: 6_000,
    inUse: readInUse,
    look: lookAtOwn,
  });
}
