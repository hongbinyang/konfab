import { randomInt, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { konfabHome } from "../server/config.js";
import {
  TelegramClient,
  TelegramError,
  type Chat,
} from "../server/telegram/client.js";
import {
  readSettings,
  removeSettings,
  writeSettings,
  type TelegramSettings,
} from "../server/telegram/store.js";
import {
  KEYCHAIN_SLOTS,
  botId,
  removeTelegramToken,
  resolveTelegramToken,
  storeTelegramToken,
  type TokenSlot,
} from "../server/telegram/token.js";

const CODE_MINUTES = 5;
const POLL_MS = 3_000;
/** A bot with this many waiting messages isn't a new one. */
const TOO_MANY = 50;

export type SetupDeps = {
  home: string;
  say: (line: string) => void;
  ask: (question: string) => Promise<string>;
  platform: NodeJS.Platform;
  /** Whether KONFAB_TELEGRAM_TOKEN is to be used. */
  fromEnvironment: boolean;
  storeToken: (slot: TokenSlot) => boolean;
  removeToken: (slot: TokenSlot) => boolean;
  token: (slot: TokenSlot) => string | null;
  client: (token: string) => TelegramClient;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  code: () => string;
};

const yes = async (deps: SetupDeps, question: string) =>
  /^y(es)?$/i.test((await deps.ask(`${question} [y/N] `)).trim());

// Without letters and digits that look alike.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const newCode = () => {
  const part = () =>
    Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
      "",
    );
  return `KONFAB-${part()}-${part()}`;
};

/** Only the chat whose own person sent exactly this code, after it was shown. */
async function chatFromCode(
  deps: SetupDeps,
  client: TelegramClient,
  bot: string,
): Promise<Chat | null> {
  const first = await client.waitingMessages();
  if (first.total >= TOO_MANY) {
    deps.say(
      "This bot already has many waiting messages, so it isn't a new one. Make a bot only for Konfab.",
    );
    return null;
  }
  const code = deps.code();
  // Telegram counts in seconds, and its clock can differ a little.
  const shownAt = Math.floor(deps.now() / 1000) - 5;
  deps.say(
    `\nIn Telegram on your phone, open @${bot}, press Start, and send exactly this within ${CODE_MINUTES} minutes:\n\n    ${code}\n\nWaiting…`,
  );
  const until = deps.now() + CODE_MINUTES * 60_000;
  while (deps.now() < until) {
    await deps.sleep(POLL_MS);
    let messages;
    try {
      ({ messages } = await client.waitingMessages());
    } catch (error) {
      if (error instanceof TelegramError && error.delivered !== "never")
        continue;
      throw error;
    }
    const match = messages.find(
      (message) => message.text.trim() === code && message.date >= shownAt,
    );
    if (match) return match.chat;
  }
  deps.say("The code didn't arrive in time.");
  return null;
}

/**
 * Sets up, or replaces, the lead's phone notices. Until the last question is
 * answered and the new setup is written in one step, the earlier one is
 * untouched and keeps working; on any failure the new token is removed again.
 */
export async function setupTelegram(deps: SetupDeps): Promise<boolean> {
  const { say } = deps;
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
  if (!deps.fromEnvironment && deps.platform !== "darwin") {
    say(
      `Set KONFAB_TELEGRAM_TOKEN for this command and the server, from a file only you can read. ${unchanged()}`,
    );
    return false;
  }
  const slot: TokenSlot = deps.fromEnvironment
    ? "env"
    : before?.slot === "a"
      ? "b"
      : "a";
  let done = false;
  try {
    const settings = await newSetup(deps, slot);
    if (settings) {
      // The one step in which the new setup replaces the earlier one.
      writeSettings(deps.home, settings);
      done = true;
      say(
        settings.enabled
          ? "Phone notices are on. They are sent only after you've been off the Konfab page for a while; turn them off there at any time."
          : "Set up, and off. Turn them on from the Konfab page, under Lead.",
      );
    } else say(unchanged());
  } catch (error) {
    say(
      `${
        error instanceof TelegramError
          ? error.conflict
            ? "Something else is reading this bot. Nothing was changed there. Make a bot only for Konfab."
            : error.message
          : "Setup had a problem."
      } ${unchanged()}`,
    );
  } finally {
    // The token that isn't used now: the new one, or the replaced one.
    const unused = done ? before?.slot : slot;
    if (unused && unused !== "env" && (done ? unused !== slot : true))
      removeQuietly(deps, unused);
  }
  return done;
}

function removeQuietly(deps: SetupDeps, slot: TokenSlot): void {
  let removed: boolean;
  try {
    removed = deps.removeToken(slot);
  } catch {
    removed = false;
  }
  if (!removed)
    deps.say(
      `An unused token couldn't be removed from the Keychain (konfab-telegram-token-${slot}). It isn't used; the next setup replaces it.`,
    );
}

/** Asks and checks everything. Writes nothing but the new token's own slot. */
async function newSetup(
  deps: SetupDeps,
  slot: TokenSlot,
): Promise<TelegramSettings | null> {
  const { say } = deps;
  if (slot !== "env") {
    say(
      "Paste the token from @BotFather (it isn't shown). It is kept in your Keychain.",
    );
    if (!deps.storeToken(slot)) {
      say("The token wasn't saved.");
      return null;
    }
  }
  const token = deps.token(slot);
  if (!token) {
    say("That isn't a bot token.");
    return null;
  }
  const client = deps.client(token);
  const bot = await client.botName();
  if (await client.hasWebhook()) {
    say(
      "This bot is used by something else (it has a webhook). Nothing was changed there. Make a bot only for Konfab.",
    );
    return null;
  }
  say(`The bot is @${bot}.`);
  let chat: Chat | null;
  let typed = false;
  if (
    await yes(
      deps,
      "Konfab can find your chat by a code you send the bot. For that it reads the messages waiting for the bot, which can briefly interrupt another program reading it. Go on?",
    )
  )
    chat = await chatFromCode(deps, client, bot);
  else {
    const number = (
      await deps.ask("Type your chat number instead (empty to stop): ")
    ).trim();
    // A person's chat; groups and channels are negative.
    if (!/^[1-9]\d{0,15}$/.test(number)) return null;
    chat = { id: Number(number), name: `chat ending in ${number.slice(-2)}` };
    typed = true;
  }
  if (!chat) return null;
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
  return {
    chat_id: chat.id,
    chat_name: chat.name,
    enabled: await yes(deps, "Turn phone notices on?"),
    slot,
    bot_id: botId(token),
    setup_id: randomUUID(),
  };
}

export async function runTelegramSetup(args: string[]): Promise<boolean> {
  const others = args.filter(
    (arg) => arg !== "--telegram" && arg !== "--remove",
  );
  if (others.length || args.length !== new Set(args).size)
    throw new Error("Use --telegram, optionally with --remove, on its own.");
  const home = konfabHome();
  if (args.includes("--remove")) {
    const had = readSettings(home) !== null;
    // First, so that nothing is sent even if a token stays.
    removeSettings(home);
    const removed = KEYCHAIN_SLOTS.map(removeTelegramToken).every(Boolean);
    console.log(
      !removed
        ? "Phone notices are off, but the token couldn't be removed from the Keychain."
        : had
          ? "Phone notices are off; the chat and the stored token are removed. To end the bot itself, tell @BotFather."
          : "Phone notices weren't set up; any stored token is removed.",
    );
    return removed;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Run Telegram setup in an interactive terminal.");
  // Only for the command's own tests, and only on this computer.
  const standIn =
    process.env.KONFAB_ISOLATED === "1" &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.KONFAB_TELEGRAM_TEST ?? "")
      ? process.env.KONFAB_TELEGRAM_TEST
      : undefined;
  return setupTelegram({
    home,
    say: console.log,
    ask: async (question) => {
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
    platform: process.env.KONFAB_ISOLATED === "1" ? "linux" : process.platform,
    fromEnvironment: Boolean(process.env.KONFAB_TELEGRAM_TOKEN),
    storeToken: storeTelegramToken,
    removeToken: removeTelegramToken,
    token: (slot) => resolveTelegramToken(slot),
    client: (token) => new TelegramClient(token, standIn),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: Date.now,
    code: newCode,
  });
}
