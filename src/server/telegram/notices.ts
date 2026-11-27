import type { Db } from "../db/index.js";
import { TelegramClient, TelegramError } from "./client.js";
import {
  readSettings,
  readState,
  settingsStamp,
  writeState,
  type NoticeState,
} from "./store.js";
import { turn } from "./places.js";
import { botId, type TokenRead, type TokenSlot } from "./token.js";

export type NoticeOptions = {
  away_minutes: number;
  quiet_from: string | null;
  quiet_to: string | null;
  room_names: boolean;
  /** Short excerpts of the messages that need the lead. */
  message_text: boolean;
  room_every_minutes: number;
  max_per_day: number;
};

export type Kind = "message" | "permission" | "event" | "report";
/** Something that still needs the lead. */
export type Need = {
  kind: Kind;
  id: number;
  room_id: number;
  room: string;
  created_at: number;
};

const GATHER_MS = 60_000;
const TRIES = 3;
const RETRY_MS = 30_000;
const UNKNOWN_MS = 10 * 60_000;

export type NoticesView = {
  state: "not_set_up" | "off" | "on";
  chat_name: string | null;
  away_minutes: number;
  problem: string | null;
};

/**
 * Short notices to the lead's phone while the lead is away: that something
 * needs them, and, unless that is turned off, short excerpts of the messages.
 * Sending is apart from everything else, so rooms never wait for it.
 */
export class TelegramNotices {
  private lastActivity: number;
  private running: Promise<void> | null = null;
  private problem: string | null = null;
  /** Set when trying again can't help until something is changed. */
  private stuckAt: string | null = null;
  private retryAt = 0;
  private tries = 0;

  constructor(
    private readonly deps: {
      db: Db;
      /** Secrets in use, hidden if a message quotes them. */
      secrets?: () => string[];
      home: string;
      options: NoticeOptions;
      token: (place: { slot: TokenSlot; item?: string }) => Promise<TokenRead>;
      client?: (token: string) => Pick<TelegramClient, "send">;
      now?: () => number;
      warn?: (message: string) => void;
    },
  ) {
    // Whether the lead is there isn't known after a start, so assume so.
    this.lastActivity = this.now();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The lead did something on the page. */
  active(): void {
    this.lastActivity = this.now();
  }

  view(): NoticesView {
    const settings = readSettings(this.deps.home);
    return {
      state: !settings ? "not_set_up" : settings.enabled ? "on" : "off",
      chat_name: settings?.chat_name ?? null,
      away_minutes: this.deps.options.away_minutes,
      problem: settings?.enabled ? this.problem : null,
    };
  }

  async setEnabled(enabled: boolean): Promise<NoticesView> {
    if (readSettings(this.deps.home)) {
      // Also what "try again" does after a problem.
      this.problem = null;
      this.stuckAt = null;
      this.retryAt = 0;
      this.tries = 0;
      await turn(this.deps.home, enabled, this.newest());
    }
    return this.view();
  }

  /** One pass; never two at once, and never throws. */
  tick(): Promise<void> {
    this.running ??= this.pass()
      .catch(() => {
        this.fail("Phone notices had a problem.");
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** Once a notice being sent is done. */
  async settled(): Promise<void> {
    await this.running;
  }

  private async pass(): Promise<void> {
    const stamp = settingsStamp(this.deps.home);
    const settings = readSettings(this.deps.home);
    if (!settings?.enabled) return;
    /** Nothing of an earlier setup, or from before it was off, is written. */
    const keep = (value: NoticeState) => {
      if (settingsStamp(this.deps.home) === stamp)
        writeState(this.deps.home, value);
    };
    const now = this.now();
    let state = readState(this.deps.home, settings.setup_id);
    if (!state.baseline) {
      state = { ...state, baseline: this.newest() };
      writeState(this.deps.home, state);
    }
    const { options } = this.deps;
    if (
      this.stuckAt === settingsStamp(this.deps.home) ||
      now < this.retryAt ||
      now - this.lastActivity < options.away_minutes * 60_000 ||
      this.quiet(now)
    )
      return;
    const today = localDay(now);
    if (state.day !== today) state = { ...state, day: today, day_count: 0 };
    if (state.day_count >= options.max_per_day) return;
    const needs = this.needs(state).filter(
      (need) =>
        now - (state.rooms[need.room_id]?.sent_at ?? 0) >=
        options.room_every_minutes * 60_000,
    );
    // A moment for related things to become one notice.
    if (!needs.some((need) => now - need.created_at >= GATHER_MS)) return;
    const read = await this.deps.token(settings);
    if (read.state === "unknown") {
      // A locked Keychain, for example. Not asked again and again.
      this.retryAt = this.now() + UNKNOWN_MS;
      this.fail("The stored bot token couldn't be read.");
      return;
    }
    // Never with a token that isn't this setup's own.
    if (read.state === "none" || botId(read.token) !== settings.bot_id) {
      this.stuckAt = settingsStamp(this.deps.home);
      this.fail(
        read.state === "found"
          ? "The stored bot token is for another bot. Run setup again."
          : "The bot token isn't stored any more. Run setup again.",
      );
      return;
    }
    // Chat, bot and token of one setup, which is still the one and on.
    if (settingsStamp(this.deps.home) !== stamp) return;
    const { token } = read;
    // Read, answered or gone while the token was read: not told any more.
    const still = new Set(
      this.needs(state).map((need) => `${need.kind}:${need.id}`),
    );
    const current = needs.filter((need) =>
      still.has(`${need.kind}:${need.id}`),
    );
    if (!current.length) return;
    // Made now, and kept nowhere.
    const text = this.text(current, [token, ...(this.deps.secrets?.() ?? [])]);
    const before = state;
    const after = this.marked(state, current, now);
    // Recorded first: a crash can lose a notice, but never repeat it.
    writeState(this.deps.home, after);
    try {
      const client = (
        this.deps.client ?? ((value) => new TelegramClient(value))
      )(token);
      await client.send(settings.chat_id, text);
      this.problem = null;
      this.tries = 0;
    } catch (error) {
      const known =
        error instanceof TelegramError
          ? error
          : new TelegramError("Phone notices had a problem.", "maybe");
      if (known.delivered === "never") {
        this.stuckAt = settingsStamp(this.deps.home);
        keep(before);
      } else if (known.delivered === "no") {
        this.tries += 1;
        // After a few tries, wait as long as for a new notice.
        const wait = this.tries < TRIES ? RETRY_MS * this.tries : 10 * 60_000;
        if (this.tries >= TRIES) this.tries = 0;
        this.retryAt =
          this.now() + Math.max(wait, (known.retryAfterSeconds ?? 0) * 1000);
        keep(before);
      }
      this.fail(known.message);
    }
  }

  /** A message's sender and text, read only to make a notice. */
  private message(id: number): { sender: string; body: string } | null {
    const row = this.deps.db
      .prepare(
        `SELECT m.body, COALESCE(a.display_name, m.sender_id) AS sender
         FROM messages m LEFT JOIN agents a ON a.id = m.sender_id WHERE m.id = ?`,
      )
      .get(id) as { body: string; sender: string } | undefined;
    return row ? { sender: row.sender, body: row.body } : null;
  }

  private fail(message: string): void {
    if (this.problem === message) return;
    this.problem = message;
    this.deps.warn?.(`Phone notices: ${message}`);
  }

  private text(needs: Need[], secrets: string[]): string {
    if (this.deps.options.message_text)
      return noticeText(needs, (id) => this.message(id), secrets);
    const kinds = new Set(needs.map((need) => need.kind));
    const what =
      kinds.size > 1
        ? "your rooms need you."
        : kinds.has("message")
          ? "a room needs you."
          : kinds.has("permission")
            ? "a permission request is waiting."
            : "a room has stopped.";
    const names = [...new Set(needs.map((need) => need.room))];
    return `Konfab: ${what}${
      this.deps.options.room_names
        ? ` (${names
            .slice(0, 5)
            .map((name) => hidden(name, secrets).slice(0, 64))
            .join(", ")}${names.length > 5 ? ", …" : ""})`
        : ""
    }`;
  }

  private marked(state: NoticeState, needs: Need[], now: number): NoticeState {
    const rooms = { ...state.rooms };
    for (const need of needs) {
      const room = rooms[need.room_id] ?? { ...this.base(state), sent_at: 0 };
      rooms[need.room_id] = {
        ...room,
        [need.kind]: Math.max(room[need.kind], need.id),
        sent_at: now,
      };
    }
    return { ...state, rooms, day_count: state.day_count + 1 };
  }

  private base(state: NoticeState) {
    return state.baseline ?? { message: 0, permission: 0, event: 0, report: 0 };
  }

  private newest() {
    const max = (table: string) =>
      (
        this.deps.db
          .prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`)
          .get() as { id: number }
      ).id;
    return {
      message: max("messages"),
      permission: max("permission_requests"),
      event: max("events"),
      report: max("agent_reports"),
    };
  }

  /** What still needs the lead, and hasn't been sent. */
  private needs(state: NoticeState): Need[] {
    const { db } = this.deps;
    const paused = db
      .prepare("SELECT value FROM settings WHERE key = 'paused_all'")
      .get() as { value: string } | undefined;
    if (paused && ["1", "true"].includes(paused.value)) return [];
    const from = this.base(state);
    const rooms = "r.archived_at IS NULL AND r.paused = 0 AND r.on_break = 0";
    const found: Need[] = [
      // Read while the lead was really there; a page left open reads by itself.
      ...(db
        .prepare(
          `SELECT 'message' AS kind, m.id, m.room_id, r.name AS room, m.created_at
           FROM messages m JOIN rooms r ON r.id = m.room_id
           WHERE m.id > ? AND m.sender_type = 'agent' AND ${rooms}
             AND EXISTS (SELECT 1 FROM json_each(m.mentions) x WHERE x.value = 'lead')
             AND NOT (m.created_at <= ? AND (m.id <= r.lead_read_cursor OR EXISTS (
               SELECT 1 FROM lead_seen_messages s WHERE s.room_id = m.room_id AND s.message_id = m.id)))
             AND NOT EXISTS (SELECT 1 FROM messages u WHERE u.room_id = m.room_id AND u.id > m.id
               AND u.sender_type = 'user' AND u.sender_id = 'user')`,
        )
        .all(from.message, this.lastActivity) as Need[]),
      ...(db
        .prepare(
          `SELECT 'permission' AS kind, p.id, p.room_id, r.name AS room, p.created_at
           FROM permission_requests p JOIN rooms r ON r.id = p.room_id
           WHERE p.id > ? AND p.state = 'pending' AND ${rooms}`,
        )
        .all(from.permission) as Need[]),
      ...(db
        .prepare(
          `SELECT 'event' AS kind, e.id, e.room_id, r.name AS room, e.created_at
           FROM events e JOIN rooms r ON r.id = e.room_id
           WHERE e.id > ? AND ${rooms} AND (
             (e.type = 'contact_lost' AND EXISTS (SELECT 1 FROM sessions s
                WHERE s.room_id = e.room_id AND s.agent_id = e.agent_id
                  AND s.state = 'active' AND s.contact_lost_at IS NOT NULL))
             OR (e.type = 'run_window_ended' AND NOT EXISTS (SELECT 1 FROM sessions s
                WHERE s.room_id = e.room_id AND s.agent_id = e.agent_id AND s.state = 'active'))
             OR (e.type = 'automatic_capped' AND EXISTS (SELECT 1 FROM automatic_continuations c
                WHERE c.room_id = e.room_id AND c.state = 'capped')))`,
        )
        .all(from.event) as Need[]),
      ...(db
        .prepare(
          `SELECT 'report' AS kind, a.id, a.room_id, r.name AS room, a.created_at
           FROM agent_reports a JOIN rooms r ON r.id = a.room_id
           WHERE a.id > ? AND a.dismissed_at IS NULL
             AND a.kind IN ('out_of_allowance', 'blocked') AND ${rooms}`,
        )
        .all(from.report) as Need[]),
    ];
    return found.filter(
      (need) => need.id > (state.rooms[need.room_id]?.[need.kind] ?? 0),
    );
  }

  private quiet(now: number): boolean {
    const { quiet_from, quiet_to } = this.deps.options;
    if (!quiet_from || !quiet_to || quiet_from === quiet_to) return false;
    const date = new Date(now);
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    return quiet_from < quiet_to
      ? time >= quiet_from && time < quiet_to
      : time >= quiet_from || time < quiet_to;
  }
}

function localDay(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** At most this many excerpts, of at most this many characters each. */
export const EXCERPTS = 3;
export const EXCERPT_CHARS = 300;
/** The whole notice stays well under Telegram's 4096. */
export const NOTICE_CHARS = 3500;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Cut at a whole character as people see it, never inside one. */
export function cut(text: string, most: number): string {
  const parts = [...graphemes.segment(text)].map((part) => part.segment);
  if (parts.length <= most) return text;
  return `${parts
    .slice(0, most - 1)
    .join("")
    .trimEnd()}…`;
}

/** Best effort only: what looks like a token, and the tokens in use. */
// A token ends where its characters end, also after "_" or "-".
const TOKEN_FORMS = [
  /\b\d{5,20}:[A-Za-z0-9_-]{30,64}(?![A-Za-z0-9_-])/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})(?![A-Za-z0-9_-])/g,
  // Konfab's own: agents', sign-in, session and watcher tokens.
  /\bkf[blsw]_[A-Za-z0-9_-]{8,}/g,
];
export function hidden(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets)
    if (secret.length >= 8) out = out.split(secret).join("[hidden]");
  for (const form of TOKEN_FORMS) out = out.replace(form, "[hidden]");
  return out;
}

const GENERIC: Record<Kind, string> = {
  message: "a message needs you.",
  permission: "a permission request is waiting.",
  event: "a room has stopped.",
  report: "a room has stopped.",
};

/**
 * One notice for everything found: grouped by room, the newest excerpts
 * first, then how many more there are, which aren't sent later.
 */
export function noticeText(
  needs: Need[],
  message: (id: number) => { sender: string; body: string } | null,
  secrets: string[],
): string {
  const ordered = [...needs].sort((a, b) => b.created_at - a.created_at);
  const shown: { need: Need; line: string }[] = [];
  let excerpts = 0;
  let more = 0;
  for (const need of ordered) {
    if (need.kind === "message") {
      const found = excerpts < EXCERPTS ? message(need.id) : null;
      if (!found) {
        more += 1;
        continue;
      }
      excerpts += 1;
      const body = hidden(found.body, secrets).replace(/\s+/g, " ").trim();
      shown.push({
        need,
        line: `${cut(hidden(found.sender, secrets), 40)}: ${cut(body, EXCERPT_CHARS)}`,
      });
    } else if (
      !shown.some(
        (one) =>
          one.need.room_id === need.room_id && one.need.kind === need.kind,
      )
    )
      shown.push({ need, line: GENERIC[need.kind] });
  }
  const rooms = new Map<number, { name: string; lines: string[] }>();
  for (const { need, line } of shown) {
    const room = rooms.get(need.room_id) ?? { name: need.room, lines: [] };
    room.lines.push(line);
    rooms.set(need.room_id, room);
  }
  const blocks = [...rooms.values()].map((room) =>
    [`Konfab · ${cut(hidden(room.name, secrets), 64)}`, ...room.lines].join(
      "\n",
    ),
  );
  const tail = (count: number) =>
    count ? `+${count} more, not sent here; open Konfab to read them.` : "";
  // The whole notice within its budget, names and count included.
  let text = "";
  let dropped = 0;
  for (const [index, block] of blocks.entries()) {
    const next = text ? `${text}\n\n${block}` : block;
    const rest = blocks.length - index - 1;
    if ((next + tail(more + rest)).length + 2 > NOTICE_CHARS) {
      dropped = blocks.length - index;
      break;
    }
    text = next;
  }
  const end = tail(more + dropped);
  return [text || "Konfab: a room needs you.", end]
    .filter(Boolean)
    .join("\n\n");
}
