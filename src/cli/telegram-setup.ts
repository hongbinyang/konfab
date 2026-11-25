import { createInterface } from "node:readline/promises";
import { konfabHome } from "../server/config.js";
import { SettingsError } from "../server/settings-file.js";
import { TelegramClient, type Chat } from "../server/telegram/client.js";
import {
  beginItem,
  commit,
  dropNote,
  giveUp,
  isPairing,
  leftOver,
  newSetupId,
  noteReady,
  noteUnknown,
  removeSetup,
  turn,
} from "../server/telegram/places.js";
import {
  chatFromCode,
  checkBot,
  CODE_MINUTES,
  newCode,
  problemText,
  SetupProblem,
} from "../server/telegram/steps.js";
import {
  readSettings,
  type TelegramSettings,
} from "../server/telegram/store.js";
import {
  botId,
  isOldItem,
  itemOf,
  Keychain,
} from "../server/telegram/token.js";

export { newCode };

export type SetupDeps = {
  home: string;
  say: (line: string) => void;
  ask: (question: string) => Promise<string>;
  keychain: Pick<
    Keychain,
    "usable" | "fromEnvironment" | "read" | "remove" | "storeByHand"
  >;
  client: (
    token: string,
  ) => Pick<
    TelegramClient,
    "botName" | "hasWebhook" | "waitingMessages" | "send"
  >;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  code: () => string;
};

const yes = async (deps: Pick<SetupDeps, "ask">, question: string) =>
  /^y(es)?$/i.test((await deps.ask(`${question} [y/N] `)).trim());

/**
 * Stores a token from the terminal in an item of its own, and reads it back.
 * Null when it surely isn't stored.
 */
async function storeNew(
  deps: SetupDeps,
  code: string,
  claimed: string | null,
): Promise<{ item: string; token: string } | null> {
  const { home, say, keychain } = deps;
  const item = await beginItem(home, code, deps.now(), claimed);
  say(
    "Paste the token from @BotFather (it isn't shown). It is kept in your Keychain.",
  );
  let stored = false;
  try {
    stored = keychain.storeByHand(item);
  } catch {
    // What became of it is seen below.
  }
  let read: Awaited<ReturnType<Keychain["read"]>> = { state: "unknown" };
  try {
    read = await keychain.read({ slot: "own", item });
  } catch {
    // Unknown.
  }
  if (read.state === "found") {
    await noteReady(home, item, botId(read.token));
    return { item, token: read.token };
  }
  if (read.state === "none") {
    await dropNote(home, item);
    say("The token wasn't saved.");
    return null;
  }
  await noteUnknown(home, item);
  say(
    stored
      ? "That isn't a bot token, or macOS didn't give it back."
      : "It isn't known whether the token was saved.",
  );
  return null;
}

/** Only an item that nothing can use any more. */
async function forget(deps: SetupDeps, item: string): Promise<void> {
  let removed = false;
  try {
    const given = await giveUp(deps.home, item, null);
    if (given) {
      const result = await deps.keychain.remove(given);
      if (result !== "unknown") {
        await dropNote(deps.home, given);
        removed = true;
      }
    }
  } catch {
    // Said below.
  }
  if (!removed)
    deps.say(
      `A token that isn't used may still be in your Keychain (${item}). Settings in the page shows it.`,
    );
}

/**
 * Sets up, or replaces, the lead's phone notices. Until the last question is
 * answered and the new setup is written in one step, the earlier one is
 * untouched and keeps working; on any failure the new token is removed again.
 */
export async function setupTelegram(deps: SetupDeps): Promise<boolean> {
  const { say, keychain } = deps;
  const before = readSettings(deps.home);
  const unchanged = () =>
    before
      ? "Nothing was changed; the earlier setup is as it was."
      : "Nothing was set up.";
  say(
    "Phone notices through Telegram. They say only that a room needs you, never what was written.\n" +
      "Telegram carries them, so it sees them and when they are sent.\n" +
      "First make a new bot only for Konfab: in Telegram, write to @BotFather and send /newbot.",
  );
  if (before)
    say(
      `Phone notices are already set up, for ${before.chat_name}. That stays as it is until this setup is complete.`,
    );
  if (
    !(await yes(
      deps,
      "Setup will now ask for the bot's token and contact Telegram to check it. Go on?",
    ))
  )
    return false;
  if (!keychain.fromEnvironment && !keychain.usable) {
    say(
      `Set KONFAB_TELEGRAM_TOKEN for this command and the server, from a file only you can read. ${unchanged()}`,
    );
    return false;
  }
  const setup = newSetupId();
  let item: string | null = null;
  let done = false;
  try {
    let token: string;
    if (keychain.fromEnvironment) {
      const read = await keychain.read({ slot: "env" });
      if (read.state !== "found")
        throw new SetupProblem("That isn't a bot token.");
      token = read.token;
    } else {
      const stored = await storeNew(deps, "", setup);
      if (!stored) {
        say(unchanged());
        return false;
      }
      ({ item, token } = stored);
    }
    const chosen = await newSetup(deps, token);
    if (chosen) {
      const next: TelegramSettings = {
        chat_id: chosen.chat.id,
        chat_name: chosen.chat.name,
        enabled: chosen.enabled,
        ...(item ? { slot: "own", item } : { slot: "env" }),
        bot_id: botId(token),
        setup_id: setup,
      };
      // The one step in which the new setup replaces the earlier one.
      const result = await commit(
        deps.home,
        next,
        before?.setup_id ?? null,
        deps.now(),
      );
      if (!result.done)
        throw new SetupProblem("Phone notices were changed meanwhile.");
      done = true;
      say(
        next.enabled
          ? "Phone notices are on. They are sent only after you've been off the Konfab page for a while; turn them off there at any time."
          : "Set up, and off. Turn them on from the Konfab page, under Lead.",
      );
      if (result.old) await forget(deps, result.old);
      else if (before && isOldItem(itemOf(before)))
        say(
          `The earlier token is still in your Keychain (${itemOf(before)}), because another Konfab folder of yours may use it. Settings in the page can remove it.`,
        );
    } else say(unchanged());
  } catch (error) {
    if (!done)
      say(
        `${error instanceof SettingsError ? `${error.message}.` : problemText(error)} ${unchanged()}`,
      );
  } finally {
    // Its own, and nothing can have come to use it.
    if (!done && item) await forget(deps, item);
  }
  return done;
}

/** Asks and checks everything. Writes nothing. */
async function newSetup(
  deps: SetupDeps,
  token: string,
): Promise<{ chat: Chat; enabled: boolean } | null> {
  const { say } = deps;
  const client = deps.client(token);
  const bot = await checkBot(client);
  say(`The bot is @${bot}.`);
  let chat: Chat;
  let typed = false;
  if (
    await yes(
      deps,
      "Konfab can find your chat by a code you send the bot. For that it reads the messages waiting for the bot, which can briefly interrupt another program reading it. Go on?",
    )
  ) {
    const code = deps.code();
    chat = await chatFromCode({
      client,
      code,
      shown: () =>
        say(
          `\nIn Telegram on your phone, open @${bot}, press Start, and send exactly this within ${CODE_MINUTES} minutes:\n\n    ${code}\n\nWaiting…`,
        ),
      now: deps.now,
      sleep: deps.sleep,
    });
  } else {
    const number = (
      await deps.ask("Type your chat number instead (empty to stop): ")
    ).trim();
    // A person's chat; groups and channels are negative.
    if (!/^[1-9]\d{0,15}$/.test(number)) return null;
    chat = { id: Number(number), name: `chat ending in ${number.slice(-2)}` };
    typed = true;
  }
  if (!(await yes(deps, `Send Konfab's notices to ${chat.name}?`))) return null;
  if (await yes(deps, 'Send "Konfab: test" there now?')) {
    await client.send(chat.id, "Konfab: test");
    if (!(await yes(deps, "Did it arrive on your phone?"))) {
      say("Then check the chat and run setup again.");
      return null;
    }
  } else if (typed) {
    say(
      "With a typed chat number the test is the only proof of who receives notices.",
    );
    return null;
  }
  return { chat, enabled: await yes(deps, "Turn phone notices on?") };
}

/** For the page: only stores a token, for the setup with this code. */
export async function tokenOnly(
  deps: SetupDeps,
  code: string | undefined,
): Promise<boolean> {
  if (!isPairing(code)) {
    deps.say(
      "Start in the page: Settings, Phone notices, Set up. It shows this command with a code.",
    );
    return false;
  }
  if (deps.keychain.fromEnvironment || !deps.keychain.usable) {
    deps.say(
      "Here the token comes from KONFAB_TELEGRAM_TOKEN; nothing is stored.",
    );
    return false;
  }
  if (!(await storeNew(deps, code, null))) return false;
  deps.say("Saved. Go on in the page, within 15 minutes.");
  return true;
}

export function status(deps: SetupDeps): void {
  const settings = readSettings(deps.home);
  deps.say(
    !settings
      ? "Phone notices: not set up."
      : `Phone notices: ${settings.enabled ? "on" : "off"}, to ${settings.chat_name}. The token is ${settings.slot === "env" ? "from KONFAB_TELEGRAM_TOKEN" : `in your Keychain (${itemOf(settings)})`}.`,
  );
  for (const note of leftOver(deps.home, deps.now(), null))
    deps.say(
      `Not used, and may still be in your Keychain: ${note.item}${isOldItem(note.item) ? " (another Konfab folder of yours may use it)" : ""}`,
    );
}

export async function turnNotices(
  deps: SetupDeps,
  enabled: boolean,
): Promise<boolean> {
  const settings = await turn(deps.home, enabled);
  deps.say(
    settings
      ? `Phone notices are ${enabled ? "on" : "off"}.`
      : "Phone notices aren't set up.",
  );
  return settings !== null;
}

export async function testNotices(deps: SetupDeps): Promise<boolean> {
  const settings = readSettings(deps.home);
  if (!settings) {
    deps.say("Phone notices aren't set up.");
    return false;
  }
  if (!(await yes(deps, `Send "Konfab: test" to ${settings.chat_name} now?`)))
    return false;
  const read = await deps.keychain.read(settings);
  if (read.state !== "found" || botId(read.token) !== settings.bot_id) {
    deps.say(
      read.state === "unknown"
        ? "macOS didn't give the bot token."
        : "The bot token isn't stored any more, or is for another bot. Run setup again.",
    );
    return false;
  }
  if (readSettings(deps.home)?.setup_id !== settings.setup_id) {
    deps.say("Phone notices were changed meanwhile. Nothing was sent.");
    return false;
  }
  try {
    await deps.client(read.token).send(settings.chat_id, "Konfab: test");
  } catch (error) {
    deps.say(problemText(error));
    return false;
  }
  deps.say("Sent.");
  return true;
}

/** The setup first, so that nothing is sent even if a token stays. */
export async function removeNotices(deps: SetupDeps): Promise<boolean> {
  const before = readSettings(deps.home);
  const { removed, item } = await removeSetup(deps.home, deps.now());
  deps.say(
    removed
      ? "Phone notices are off; the chat is removed. To end the bot itself, tell @BotFather."
      : "Phone notices weren't set up.",
  );
  if (item) await forget(deps, item);
  const old = before && itemOf(before);
  if (old && isOldItem(old)) {
    if (
      await yes(
        deps,
        `Also remove the stored token (${old})? Another Konfab folder of yours may use it.`,
      )
    )
      await forget(deps, old);
    else deps.say(`The token stays in your Keychain (${old}).`);
  }
  return true;
}

export async function runTelegramSetup(args: string[]): Promise<boolean> {
  const rest = args.filter((arg) => arg !== "--telegram");
  const [action, code, ...more] = rest;
  const known = ["--remove", "--status", "--on", "--off", "--test"];
  if (
    args.length - rest.length !== 1 ||
    more.length ||
    (action !== undefined &&
      action !== "--token-only" &&
      (!known.includes(action) || code !== undefined))
  )
    throw new Error(
      `Use --telegram on its own, or with one of ${known.join(", ")}, --token-only <code>.`,
    );
  // Only for the command's own tests, and only on this computer.
  const standIn =
    process.env.KONFAB_ISOLATED === "1" &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.KONFAB_TELEGRAM_TEST ?? "")
      ? process.env.KONFAB_TELEGRAM_TEST
      : undefined;
  const person = process.stdin.isTTY && process.stdout.isTTY;
  const deps: SetupDeps = {
    home: konfabHome(),
    say: console.log,
    ask: async (question) => {
      // Nobody is there to say yes.
      if (!person) return "";
      const reader = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await reader.question(question);
      } finally {
        reader.close();
      }
    },
    keychain: new Keychain(),
    client: (token) => new TelegramClient(token, standIn),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: Date.now,
    code: newCode,
  };
  switch (action) {
    case "--remove":
      return removeNotices(deps);
    case "--status":
      status(deps);
      return true;
    case "--on":
    case "--off":
      return turnNotices(deps, action === "--on");
  }
  if (!person)
    throw new Error("Run Telegram setup in an interactive terminal.");
  if (action === "--test") return testNotices(deps);
  if (action === "--token-only") return tokenOnly(deps, code);
  return setupTelegram(deps);
}
