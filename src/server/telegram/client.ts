/**
 * Telegram's Bot API, as far as Konfab uses it. The token is part of every
 * address, so addresses and raw errors never leave this file.
 */

const TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 1024 * 1024;

/** A problem in plain words, safe to show and log. */
export class TelegramError extends Error {
  constructor(
    message: string,
    /**
     * "no": not delivered. "maybe": it may have been. "never": it won't be
     * until something is changed.
     */
    readonly delivered: "no" | "maybe" | "never",
    readonly retryAfterSeconds?: number,
    readonly conflict = false,
  ) {
    super(message);
  }
}

export type Chat = { id: number; name: string };
export type BotMessage = { chat: Chat; text: string; date: number };

export const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{30,64}$/;

export class TelegramClient {
  private readonly token: string;
  private readonly base: string;

  constructor(
    token: string,
    /** Tests only: a stand-in on this computer. */
    base = "https://api.telegram.org",
    private readonly timeoutMs = TIMEOUT_MS,
  ) {
    if (!TOKEN_PATTERN.test(token))
      throw new TelegramError("That isn't a bot token.", "never");
    this.token = token;
    this.base = base;
  }

  async botName(): Promise<string> {
    const me = await this.call("getMe");
    return field(me, "username") ?? "the bot";
  }

  async hasWebhook(): Promise<boolean> {
    return Boolean(field(await this.call("getWebhookInfo"), "url"));
  }

  /**
   * Text messages waiting for the bot in private chats, from the chat's own
   * person. Confirms none of them (no offset), so they stay for other readers.
   */
  async waitingMessages(): Promise<{ messages: BotMessage[]; total: number }> {
    const updates = await this.call("getUpdates", { limit: 100, timeout: 0 });
    const list: unknown[] = Array.isArray(updates) ? updates : [];
    const messages: BotMessage[] = [];
    for (const update of list) {
      const message = part(update, "message");
      const chat = part(message, "chat");
      const from = part(message, "from");
      const id = chat?.id;
      const text = message?.text;
      if (
        !message ||
        typeof id !== "number" ||
        typeof text !== "string" ||
        typeof message.date !== "number" ||
        chat?.type !== "private" ||
        from?.id !== id ||
        from.is_bot !== false ||
        message.forward_origin !== undefined ||
        message.forward_date !== undefined ||
        message.via_bot !== undefined
      )
        continue;
      const name = [field(chat, "first_name"), field(chat, "last_name")]
        .filter(Boolean)
        .join(" ");
      const username = field(chat, "username");
      messages.push({
        chat: {
          id,
          name:
            [name, username && `@${username}`].filter(Boolean).join(" ") ||
            "a chat without a name",
        },
        text,
        date: message.date,
      });
    }
    return { messages, total: list.length };
  }

  async send(chatId: number, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text });
  }

  private async call(method: string, body: object = {}): Promise<unknown> {
    let status: number;
    let reply: string;
    try {
      const response = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = response.status;
      reply = await limitedText(response);
    } catch (error) {
      // The original error can hold the address, so nothing of it is kept.
      const code = causeCode(error);
      if (
        code &&
        [
          "ENOTFOUND",
          "EAI_AGAIN",
          "ECONNREFUSED",
          "ENETUNREACH",
          "EHOSTUNREACH",
          "UND_ERR_CONNECT_TIMEOUT",
        ].includes(code)
      )
        throw new TelegramError("Telegram can't be reached.", "no");
      throw new TelegramError("Telegram didn't answer in time.", "maybe");
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(reply) as Record<string, unknown>;
    } catch {
      // Handled by its status below.
    }
    if (status === 200 && parsed?.ok === true) return parsed.result;
    const wait = part(parsed, "parameters")?.retry_after;
    if (status === 429)
      throw new TelegramError(
        "Telegram asked to wait before sending more.",
        "no",
        typeof wait === "number" && wait > 0 ? Math.min(wait, 3600) : 60,
      );
    if (status === 401 || status === 404)
      throw new TelegramError("Telegram refused the bot token.", "never");
    if (status === 403)
      throw new TelegramError(
        "The bot can't write to the chat; it may have been blocked or deleted there.",
        "never",
      );
    if (status === 400)
      throw new TelegramError(
        "Telegram refused the message; the chat may be gone.",
        "never",
      );
    if (status === 409)
      throw new TelegramError(
        "Something else is using this bot.",
        "never",
        undefined,
        true,
      );
    throw new TelegramError("Telegram had a problem.", "maybe");
  }
}

function part(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const inner = (value as Record<string, unknown>)[key];
  return typeof inner === "object" && inner !== null
    ? (inner as Record<string, unknown>)
    : null;
}

/** Text to show, without control characters and not too long. */
function field(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const inner = (value as Record<string, unknown>)[key];
  return typeof inner === "string" && inner
    ? inner.replace(/[\p{C}]/gu, "").slice(0, 80)
    : undefined;
}

function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

async function limitedText(response: Response): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body ?? []) {
    text += decoder.decode(chunk as Uint8Array, { stream: true });
    if (text.length > MAX_REPLY_BYTES) throw new Error("too long");
  }
  return text;
}
