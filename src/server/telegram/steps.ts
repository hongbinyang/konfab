import { randomInt } from "node:crypto";
import { TelegramError, type Chat, type TelegramClient } from "./client.js";

/** What the terminal and the page ask and check alike, in the same words. */
export const CODE_MINUTES = 5;
const POLL_MS = 3_000;
/** A bot with this many waiting messages isn't a new one. */
const TOO_MANY = 50;

export class SetupProblem extends Error {}

export const USED_ELSEWHERE =
  "This bot is used by something else (it has a webhook). Nothing was changed there. Make a bot only for Konfab.";
export const NOT_NEW =
  "This bot already has many waiting messages, so it isn't a new one. Make a bot only for Konfab.";
export const LATE = "The code didn't arrive in time.";

/** Plain words, never with a token or an address. */
export const problemText = (error: unknown): string =>
  error instanceof SetupProblem
    ? error.message
    : error instanceof TelegramError
      ? error.conflict
        ? "Something else is reading this bot. Nothing was changed there. Make a bot only for Konfab."
        : error.message
      : "Setup had a problem.";

// Without letters and digits that look alike.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const newCode = () => {
  const part = () =>
    Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
      "",
    );
  return `KONFAB-${part()}-${part()}`;
};

export async function checkBot(
  client: Pick<TelegramClient, "botName" | "hasWebhook">,
): Promise<string> {
  const bot = await client.botName();
  if (await client.hasWebhook()) throw new SetupProblem(USED_ELSEWHERE);
  return bot;
}

/** Only the chat whose own person sent exactly this code, after it was shown. */
export async function chatFromCode(deps: {
  client: Pick<TelegramClient, "waitingMessages">;
  code: string;
  shown: () => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stopped?: () => boolean;
}): Promise<Chat> {
  const { client, code } = deps;
  const first = await client.waitingMessages();
  if (first.total >= TOO_MANY) throw new SetupProblem(NOT_NEW);
  // Telegram counts in seconds, and its clock can differ a little.
  const shownAt = Math.floor(deps.now() / 1000) - 5;
  deps.shown();
  const until = deps.now() + CODE_MINUTES * 60_000;
  while (deps.now() < until) {
    await deps.sleep(POLL_MS);
    if (deps.stopped?.()) throw new SetupProblem("Setup was ended.");
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
  throw new SetupProblem(LATE);
}
