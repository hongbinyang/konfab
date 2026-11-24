import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/index.js";
import { KonfabError } from "./errors.js";

/**
 * The lead asks a Codex agent to come back to a room in the conversation it
 * last joined from. A prompt can arrive hours later, so it carries a one-time
 * number, and only Konfab decides whether it is still wanted when the agent
 * calls rejoin_room. See docs/design/rejoin-agents.md.
 *
 * Pausing, breaks, archiving, removal, ordinary joins and calls close open requests
 * by database triggers, in the same transaction as the change itself.
 */

/** 32 characters, so each is 5 bits: 26 of them are 130 bits. */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";
const NUMBER = /^[A-HJKMNP-TV-Z0-9]{26}$/;
const CONVERSATION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What a shown wait turns into "not back yet" after. */
const SLOW_MS = 60_000;
const OPEN = "('sending','waiting','joined')";

/** A routing signal from the app's call metadata, not proof of anything. */
export function conversationId(value: unknown): string | null {
  return typeof value === "string" && CONVERSATION.test(value) ? value : null;
}

export function newNumber(): string {
  // 256 is a multiple of 32, so every character is equally likely.
  return Array.from(randomBytes(26), (byte) => ALPHABET[byte % 32]).join("");
}

const hash = (number: string): string =>
  createHash("sha256").update(number).digest("hex");

/** Fixed: nothing anyone wrote is in it. */
export const rejoinMessage = (number: string): string =>
  `Konfab: the lead asked you to rejoin a room. Call the Konfab tool rejoin_room with request "${number}" and follow its answer. If it says the request is closed, end your turn and do nothing else.`;

export type SendResult = "taken" | "refused" | "unsure";

type Row = {
  id: number;
  room_id: number;
  agent_id: string;
  app_id: string;
  session_id: string;
  conversation_id: string;
  state: "sending" | "waiting" | "joined" | "back" | "closed";
  unsure: number;
  reason: string | null;
  created_at: number;
  expires_at: number;
  joined_session_id: string | null;
  joined_at: number | null;
};

export type RejoinView = {
  /** Whether the lead can ask now, or why not; null where it isn't shown. */
  offer:
    | "ready"
    | "connected"
    | "old_join"
    | "unavailable"
    | "elsewhere"
    | "archived"
    | "paused"
    | "on_break"
    | null;
  request: {
    state: "waiting" | "joined" | "closed";
    unsure: boolean;
    refused: boolean;
    slow: boolean;
    asked_at: number;
  } | null;
  /** An earlier prompt may still be in Codex; asking again needs a yes. */
  earlier: boolean;
};

export const CLOSED = {
  status: "closed",
  next: "This request is closed. End your turn and do nothing else.",
} as const;

type Room = {
  id: number;
  paused: number;
  on_break: number;
  archived_at: number | null;
};

export class RejoinRequests {
  /** Whether a checked Codex command is there. Set by the server. */
  available: () => boolean = () => false;
  /** Whether it is missing because of something the lead can look into. */
  problem: () => boolean = () => false;
  wantedMs = 10 * 60_000;

  constructor(
    private readonly deps: {
      db: Db;
      now: () => number;
      room: (id: number) => Room;
      allPaused: () => boolean;
      isMember: (roomId: number, agentId: string) => boolean;
      /** Neither waiting nor working. */
      isAway: (roomId: number, agentId: string) => boolean;
      startSession: (
        roomId: number,
        agentId: string,
        sessionId: string,
        conversation: string,
      ) => void;
      newSessionId: () => string;
      reply: (roomId: number, agentId: string, sessionId: string) => object;
      logEvent: (
        type: string,
        roomId: number | null,
        agentId: string | null,
        payload: object,
      ) => void;
      notify: () => void;
    },
  ) {}

  private get db(): Db {
    return this.deps.db;
  }

  /** After a start: whether a prompt was taken isn't known any more. */
  recover(): void {
    this.db
      .prepare(
        "UPDATE rejoin_requests SET state = 'waiting', unsure = 1 WHERE state = 'sending'",
      )
      .run();
    this.closeStale();
  }

  /** Checked whenever it matters, so a sleeping computer extends nothing. */
  closeStale(): void {
    const now = this.deps.now();
    this.db.transaction(() => {
      this.close(
        "state IN ('sending','waiting') AND (expires_at <= ? OR created_at > ?)",
        [now, now],
        "expired",
      );
      // Triggers have closed these; the time and the event come from here.
      const closed = this.db
        .prepare(
          "SELECT id, room_id, agent_id, reason FROM rejoin_requests WHERE state = 'closed' AND closed_at IS NULL",
        )
        .all() as Pick<Row, "id" | "room_id" | "agent_id" | "reason">[];
      for (const row of closed) {
        this.db
          .prepare("UPDATE rejoin_requests SET closed_at = ? WHERE id = ?")
          .run(now, row.id);
        this.deps.logEvent("rejoin_closed", row.room_id, row.agent_id, {
          reason: row.reason,
        });
      }
    })();
  }

  private close(where: string, values: unknown[], reason: string): boolean {
    const rows = this.db
      .prepare(
        `SELECT id, room_id, agent_id FROM rejoin_requests WHERE ${where}`,
      )
      .all(...values) as Pick<Row, "id" | "room_id" | "agent_id">[];
    for (const row of rows) {
      this.db
        .prepare(
          `UPDATE rejoin_requests SET state = 'closed', reason = ?, closed_at = ? WHERE id = ? AND state IN ${OPEN}`,
        )
        .run(reason, this.deps.now(), row.id);
      this.deps.logEvent("rejoin_closed", row.room_id, row.agent_id, {
        reason,
      });
    }
    return rows.length > 0;
  }

  /**
   * The only app with a way to do this, whatever it is called in config.yaml:
   * its connector names the conversation. Before it first has, only the usual
   * name tells it apart, and that is only used to explain what is missing.
   */
  private isCodex(agentId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM agents a WHERE a.id = ? AND (a.app_id = 'codex' OR EXISTS (
             SELECT 1 FROM sessions s JOIN agents b ON b.id = s.agent_id
             WHERE b.app_id = a.app_id AND s.conversation_id IS NOT NULL))`,
        )
        .get(agentId),
    );
  }

  private newest(roomId: number, agentId: string) {
    return this.db
      .prepare(
        "SELECT id, conversation_id FROM sessions WHERE room_id = ? AND agent_id = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(roomId, agentId) as
      { id: string; conversation_id: string | null } | undefined;
  }

  private last(roomId: number, agentId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT * FROM rejoin_requests WHERE room_id = ? AND agent_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(roomId, agentId) as Row | undefined;
  }

  /** Waiting or working as another agent, or in another room. */
  private isElsewhere(
    roomId: number,
    agentId: string,
    conversation: string,
  ): boolean {
    const others = this.db
      .prepare(
        "SELECT DISTINCT room_id, agent_id FROM sessions WHERE conversation_id = ? AND state = 'active' AND NOT (room_id = ? AND agent_id = ?)",
      )
      .all(conversation, roomId, agentId) as {
      room_id: number;
      agent_id: string;
    }[];
    return others.some(
      (other) => !this.deps.isAway(other.room_id, other.agent_id),
    );
  }

  /** Why the room can't be joined now, or null. */
  private roomReason(
    roomId: number,
  ): "archived" | "paused" | "on_break" | null {
    const room = this.deps.room(roomId);
    if (room.archived_at !== null) return "archived";
    if (room.paused === 1 || this.deps.allPaused()) return "paused";
    return room.on_break === 1 ? "on_break" : null;
  }

  private mayBeInCodex(conversation: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM rejoin_requests WHERE conversation_id = ? AND state = 'closed'
             AND reason <> 'refused' AND joined_at IS NULL
             -- Codex delivers in order, so a later one that arrived means this did.
             AND id > (SELECT COALESCE(MAX(id), 0) FROM rejoin_requests
                       WHERE conversation_id = ? AND joined_at IS NOT NULL)
           LIMIT 1`,
        )
        .get(conversation, conversation),
    );
  }

  view(roomId: number, agentId: string): RejoinView {
    this.closeStale();
    const session = this.newest(roomId, agentId);
    const row = this.last(roomId, agentId);
    const now = this.deps.now();
    const away = this.deps.isAway(roomId, agentId);
    const asked = row?.state === "sending" || row?.state === "waiting";
    // One that joined stays so until it waits, but doesn't stop the lead from
    // asking again once contact with it is lost.
    const joined =
      row?.state === "joined" && session?.id === row.joined_session_id;
    // A closed one is shown until the agent is in contact again.
    const closed =
      row?.state === "closed" &&
      row.joined_at === null &&
      session?.id === row.session_id &&
      away;
    const activeJoin = joined && this.isActive(row.joined_session_id!);
    const base: RejoinView = {
      offer: null,
      request:
        row && (asked || activeJoin || closed)
          ? {
              state:
                row.state === "sending"
                  ? "waiting"
                  : (row.state as "waiting" | "joined" | "closed"),
              unsure: row.unsure === 1,
              refused: row.reason === "refused",
              slow:
                now -
                  (row.state === "joined" ? row.joined_at! : row.created_at) >=
                SLOW_MS,
              asked_at: row.created_at,
            }
          : null,
      earlier: false,
    };
    if (asked || !session || !this.isCodex(agentId)) return base;
    const no = (offer: RejoinView["offer"]) => ({ ...base, offer });
    if (!this.available()) return this.problem() ? no("unavailable") : base;
    if (!session.conversation_id) return no("old_join");
    // While a joined one is in contact, its own text says what is missing.
    if (!away) return activeJoin ? base : no("connected");
    return {
      ...base,
      offer:
        this.roomReason(roomId) ??
        (this.isElsewhere(roomId, agentId, session.conversation_id) ||
        this.openFor(session.conversation_id)
          ? "elsewhere"
          : "ready"),
      earlier: this.mayBeInCodex(session.conversation_id),
    };
  }

  private openFor(conversation: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM rejoin_requests WHERE conversation_id = ? AND state IN ('sending','waiting')",
        )
        .get(conversation),
    );
  }

  /**
   * Whether this conversation has called again, here or elsewhere. Triggers
   * close the request at that moment, so contact that is lost again later
   * doesn't make it wanted. A restart of Konfab counts as contact on the page,
   * but not here.
   */
  private calledSince(row: Row): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sessions WHERE (id = ? OR conversation_id = ?) AND last_call_at >= ?",
        )
        .get(row.session_id, row.conversation_id, row.created_at),
    );
  }

  private isActive(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM sessions WHERE id = ? AND state = 'active'")
        .get(sessionId),
    );
  }

  /**
   * Records the lead's request before anything is sent. `again`: the lead was
   * told that an earlier prompt may still be in Codex.
   */
  ask(
    roomId: number,
    agentId: string,
    again: boolean,
  ): { id: number; number: string; conversation: string } {
    const refuse = (code: string, message: string): never => {
      throw new KonfabError(code, 409, message);
    };
    const asked = this.db
      .transaction(() => {
        const view = this.view(roomId, agentId);
        if (
          view.offer === null &&
          (view.request?.state ?? "closed") !== "closed"
        )
          return refuse("rejoin_open", "A rejoin was already asked for");
        if (view.offer !== "ready")
          return refuse(
            "rejoin_unavailable",
            "This agent can't be asked to rejoin now; use its rejoin prompt",
          );
        if (view.earlier && !again)
          return refuse(
            "rejoin_earlier",
            "Another prompt may already be waiting in Codex",
          );
        const session = this.newest(roomId, agentId)!;
        const owner = this.db
          .prepare("SELECT app_id FROM agents WHERE id = ?")
          .get(agentId) as { app_id: string | null } | undefined;
        if (!owner?.app_id)
          return refuse(
            "rejoin_unavailable",
            "This agent can't be asked to rejoin now; use its rejoin prompt",
          );
        // Earlier ones that joined but never waited, and aren't in contact.
        this.close(
          "state = 'joined' AND ((room_id = ? AND agent_id = ?) OR conversation_id = ?)",
          [roomId, agentId, session.conversation_id],
          "lost",
        );
        const number = newNumber();
        const now = this.deps.now();
        const created = this.db
          .prepare(
            `INSERT INTO rejoin_requests (room_id, agent_id, app_id, session_id, conversation_id, number_hash, state, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
          )
          .run(
            roomId,
            agentId,
            owner.app_id,
            session.id,
            session.conversation_id,
            hash(number),
            now,
            now + this.wantedMs,
          );
        this.deps.logEvent("rejoin_asked", roomId, agentId, {});
        return {
          id: Number(created.lastInsertRowid),
          number,
          conversation: session.conversation_id!,
        };
      })
      .immediate();
    this.deps.notify();
    return asked;
  }

  /** What became of the prompt. A call that came first keeps its state. */
  sent(id: number, result: SendResult): void {
    this.db
      .transaction(() => {
        if (result === "refused")
          this.close("id = ? AND state = 'sending'", [id], "refused");
        else
          this.db
            .prepare(
              "UPDATE rejoin_requests SET state = 'waiting', unsure = ? WHERE id = ? AND state = 'sending'",
            )
            .run(result === "unsure" ? 1 : 0, id);
      })
      .immediate();
    this.deps.notify();
  }

  /** Can't take back the prompt; only makes it unwanted. */
  cancel(roomId: number, agentId: string): void {
    this.db
      .transaction(() => {
        this.closeStale();
        const row = this.last(roomId, agentId);
        if (row?.state === "joined")
          throw new KonfabError(
            "rejoin_joined",
            409,
            "The agent has already joined",
          );
        if (
          !this.close(
            "id = ? AND state IN ('sending','waiting')",
            [row?.id ?? 0],
            "cancelled",
          )
        )
          throw new KonfabError("rejoin_closed", 409, "No rejoin is waiting");
      })
      .immediate();
    this.deps.notify();
  }

  /**
   * The agent's call. Everything is checked and changed in one transaction
   * that takes the write lock first, or nothing is.
   */
  rejoin(appId: string, number: unknown, conversation: unknown): object {
    const from = conversationId(conversation);
    if (typeof number !== "string" || !NUMBER.test(number) || !from)
      return CLOSED;
    // The answer too is made inside, so that it fits what was stored.
    const reply = (row: Row, sessionId: string) =>
      this.deps.reply(row.room_id, row.agent_id, sessionId);
    const joined = this.db
      .transaction(() => {
        this.closeStale();
        const row = this.db
          .prepare("SELECT * FROM rejoin_requests WHERE number_hash = ?")
          .get(hash(number)) as Row | undefined;
        if (!row || row.app_id !== appId || row.conversation_id !== from)
          return null;
        if (row.state === "joined" || row.state === "back") {
          // A repeated call: the same session, never a second one.
          return this.isActive(row.joined_session_id!)
            ? reply(row, row.joined_session_id!)
            : null;
        }
        if (row.state !== "sending" && row.state !== "waiting") return null;
        if (
          this.roomReason(row.room_id) ||
          !this.deps.isMember(row.room_id, row.agent_id) ||
          this.newest(row.room_id, row.agent_id)?.id !== row.session_id ||
          this.calledSince(row)
        ) {
          this.close("id = ?", [row.id], "changed");
          return null;
        }
        const sessionId = this.deps.newSessionId();
        // First, so that the new session doesn't close it as an ordinary join.
        this.db
          .prepare(
            "UPDATE rejoin_requests SET state = 'joined', joined_session_id = ?, joined_at = ? WHERE id = ?",
          )
          .run(sessionId, this.deps.now(), row.id);
        this.deps.startSession(row.room_id, row.agent_id, sessionId, from);
        this.deps.logEvent("rejoin_joined", row.room_id, row.agent_id, {});
        return reply(row, sessionId);
      })
      .immediate();
    this.deps.notify();
    return joined ?? CLOSED;
  }

  /** Called inside the transaction of a wait that counts as waiting. */
  waited(sessionId: string): void {
    const row = this.db
      .prepare(
        "SELECT * FROM rejoin_requests WHERE joined_session_id = ? AND state = 'joined'",
      )
      .get(sessionId) as Row | undefined;
    if (!row) return;
    this.db
      .prepare("UPDATE rejoin_requests SET state = 'back' WHERE id = ?")
      .run(row.id);
    this.deps.logEvent("rejoined", row.room_id, row.agent_id, {});
  }
}
