import { randomInt } from "node:crypto";
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
} from "../server/telegram/store.js";
import {
  removeTelegramToken,
  resolveTelegramToken,
  storeTelegramToken,
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
  storeToken: () => boolean;
  removeToken: () => boolean;
  token: () => string | null;
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
  deps.say("The code didn't arrive in time. Nothing was set up.");
  return null;
}

export async function setupTelegram(deps: SetupDeps): Promise<boolean> {
  const { say } = deps;
  say(
    "Phone notices through Telegram. They say only that a room needs you, never what was written.\n" +
      "Telegram carries them, so it sees them and when they are sent.\n" +
      "First make a new bot only for Konfab: in Telegram, write to @BotFather and send /newbot.",
  );
  if (
    !(await yes(
      deps,
      "Setup will now ask for the bot's token and contact Telegram to check it. Go on?",
    ))
  )
    return false;
  if (deps.platform === "darwin") {
    say(
      "Paste the token from @BotFather (it isn't shown). It is kept in your Keychain.",
    );
    if (!deps.storeToken()) {
      say("The token wasn't saved. Nothing was set up.");
      return false;
    }
  }
  const token = deps.token();
  if (!token) {
    say(
      deps.platform === "darwin"
        ? "That isn't a bot token. Nothing was set up."
        : "Set KONFAB_TELEGRAM_TOKEN for this command and the server, from a file only you can read.",
    );
    if (deps.platform === "darwin") deps.removeToken();
    return false;
  }
  try {
    const client = deps.client(token);
    const bot = await client.botName();
    if (await client.hasWebhook()) {
      say(
        "This bot is used by something else (it has a webhook). Nothing was changed there. Make a bot only for Konfab.",
      );
      return false;
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
      if (!/^[1-9]\d{0,15}$/.test(number)) {
        say("Nothing was set up.");
        return false;
      }
      chat = { id: Number(number), name: `chat ending in ${number.slice(-2)}` };
      typed = true;
    }
    if (!chat) return false;
    if (!(await yes(deps, `Send Konfab's notices to ${chat.name}?`)))
      return false;
    const tested = await yes(deps, 'Send "Konfab: test" there now?');
    if (tested) {
      await client.send(chat.id, "Konfab: test");
      if (!(await yes(deps, "Did it arrive on your phone?"))) {
        say("Then it isn't set up. Check the chat and run setup again.");
        return false;
      }
    } else if (typed) {
      say(
        "With a typed chat number the test is the only proof of who receives notices, so it isn't set up.",
      );
      return false;
    }
    const enabled = await yes(deps, "Turn phone notices on?");
    removeSettings(deps.home);
    writeSettings(deps.home, {
      chat_id: chat.id,
      chat_name: chat.name,
      enabled,
    });
    say(
      enabled
        ? "Phone notices are on. They are sent only after you've been off the Konfab page for a while; turn them off there at any time."
        : "Set up, and off. Turn them on from the Konfab page, under Lead.",
    );
    return true;
  } catch (error) {
    say(
      error instanceof TelegramError
        ? error.conflict
          ? "Something else is reading this bot. Nothing was changed there. Make a bot only for Konfab."
          : `${error.message} Nothing was set up.`
        : "Setup had a problem. Nothing was set up.",
    );
    return false;
  }
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
    removeSettings(home);
    const removed = removeTelegramToken();
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
    storeToken: storeTelegramToken,
    removeToken: removeTelegramToken,
    token: () => resolveTelegramToken(),
    client: (token) => new TelegramClient(token, standIn),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: Date.now,
    code: newCode,
  });
}
