import type { Db } from "../db/index.js";
import { KonfabError } from "./errors.js";

/**
 * The lead stops one agent in one room: a running turn or reported work
 * finishes, then its session ends and its next call is answered with "stop".
 * Konfab can see that its connector has that answer, never that the model or
 * its app has stopped. See docs/design/stop-agent.md.
 */

export const STOP_INSTRUCTIONS =
  "The lead asked you to stop. End your reply now. Do not call wait_for_turn or any other Konfab tool unless the user asks you to rejoin, or a message or watcher from Konfab gives you a request for rejoin_room.";
export const STOP_LATER =
  "The lead asked you to stop after this. Finish it, then post or pass, or call wait_for_turn, and don't take on more.";
const QUIET_MS = 90_000;
const JOINED_SHOWN_MS = 10 * 60_000;

type Row = {
  id: string;
  room_id: number;
  agent_id: string;
  state: "active" | "replaced" | "ended";
  end_reason: string | null;
  ended_at: number | null;
  last_call_at: number;
  stop_asked_at: number | null;
  stop_answered_at: number | null;
  stop_received_at: number | null;
  stop_called_at: number | null;
};

export type StopView = {
  /** What a click would do, or null where there is nothing to stop. */
  can: "now" | "after_turn" | "after_work" | null;
  state: "asked" | "undelivered" | "answered" | "received" | null;
  /** What goes on while it is asked. */
  after: "turn" | "work" | null;
  asked_at: number | null;
  /** When it last called, if that is longer ago than it should be. */
  quiet_since: number | null;
  /** Its answer, or its end without one, is long enough ago. */
  long_ago: boolean;
  called_at: number | null;
  /** It joined again while a stop was asked, which therefore doesn't apply. */
  joined_again_at: number | null;
  holds_lock: boolean;
  open_permission: boolean;
};

export class Stops {
  /** The last refused request of a session, so that its repeat isn't a call. */
  private readonly refused = new Map<string, string>();

  constructor(
    private readonly deps: {
      db: Db;
      now: () => number;
      activeSession: (
        roomId: number,
        agentId: string,
      ) => { id: string } | undefined;
      /** In a turn of that room. */
      inTurn: (roomId: number, agentId: string) => boolean;
      /** It reported work not long ago, or waits for a permission. */
      hasWork: (roomId: number, agentId: string) => boolean;
      /** A wait_for_turn call of it is open. */
      isWaiting: (sessionId: string) => boolean;
      /** There to be stopped: not away, on a break or at its window's end. */
      isThere: (roomId: number, agentId: string) => boolean;
      /** No call for longer than it should be. */
      isQuiet: (roomId: number, agentId: string) => boolean;
      endSession: (sessionId: string, reason: string) => void;
      logEvent: (
        type: string,
        roomId: number,
        agentId: string,
        payload: object,
      ) => void;
      notify: () => void;
    },
  ) {}

  private get db(): Db {
    return this.deps.db;
  }

  private row(id: string): Row {
    return this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as Row;
  }

  private newest(roomId: number, agentId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE room_id = ? AND agent_id = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(roomId, agentId) as Row | undefined;
  }

  private busy(roomId: number, row: Row): "turn" | "work" | null {
    if (this.deps.inTurn(roomId, row.agent_id)) return "turn";
    return !this.deps.isWaiting(row.id) &&
      this.deps.hasWork(roomId, row.agent_id)
      ? "work"
      : null;
  }

  ask(roomId: number, agentId: string): void {
    this.db
      .transaction(() => {
        const active = this.deps.activeSession(roomId, agentId);
        const row = active && this.row(active.id);
        if (row?.stop_asked_at != null) return;
        if (!row || !this.deps.isThere(roomId, agentId))
          throw new KonfabError(
            "stop_unavailable",
            409,
            "This agent isn't there to be stopped",
          );
        this.db
          .prepare("UPDATE sessions SET stop_asked_at = ? WHERE id = ?")
          .run(this.deps.now(), row.id);
        this.deps.logEvent("stop_asked", roomId, agentId, {});
        if (!this.busy(roomId, row)) this.end(row.id);
      })
      .immediate();
    this.deps.notify();
  }

  keep(roomId: number, agentId: string): void {
    this.db
      .transaction(() => {
        const active = this.deps.activeSession(roomId, agentId);
        const kept = active
          ? this.db
              .prepare(
                "UPDATE sessions SET stop_asked_at = NULL WHERE id = ? AND state = 'active' AND stop_asked_at IS NOT NULL",
              )
              .run(active.id).changes
          : 0;
        if (!kept)
          throw new KonfabError(
            "stop_done",
            409,
            "It has stopped, or no stop was asked; use Rejoin to bring it back",
          );
        this.deps.logEvent("stop_undone", roomId, agentId, {});
      })
      .immediate();
    this.deps.notify();
  }

  isAsked(sessionId: string): boolean {
    return this.row(sessionId).stop_asked_at !== null;
  }

  /** Inside the transaction that decides. Its run window is stored with it. */
  private end(sessionId: string): void {
    const row = this.row(sessionId);
    this.deps.endSession(sessionId, "stopped");
    this.deps.logEvent("stopped", row.room_id, row.agent_id, {});
  }

  /** At the end of a turn, or at a wait: true if it has ended with it. */
  endIfAsked(sessionId: string): boolean {
    const row = this.row(sessionId);
    if (
      row.state !== "active" ||
      row.stop_asked_at === null ||
      this.deps.inTurn(row.room_id, row.agent_id)
    )
      return false;
    this.end(sessionId);
    return true;
  }

  private isStopped(row: Row | undefined): row is Row {
    return row?.state === "ended" && row.end_reason === "stopped";
  }

  hasStopped(sessionId: string): boolean {
    return this.isStopped(this.row(sessionId));
  }

  /** The first call that is answered with "stop". */
  private answer(row: Row): boolean {
    return (
      this.db
        .prepare(
          "UPDATE sessions SET stop_answered_at = ? WHERE id = ? AND stop_answered_at IS NULL",
        )
        .run(this.deps.now(), row.id).changes === 1
    );
  }

  private called(row: Row): void {
    this.db
      .prepare("UPDATE sessions SET stop_called_at = ? WHERE id = ?")
      .run(this.deps.now(), row.id);
    if (row.stop_called_at === null)
      this.deps.logEvent("called_after_stop", row.room_id, row.agent_id, {});
    this.deps.notify();
  }

  /** What a post or pass answers besides its own result. */
  withStop<T extends object>(sessionId: string, result: T): T {
    const row = this.row(sessionId);
    if (!this.isStopped(row)) return result;
    this.answer(row);
    return { ...result, stopped: true, instructions: STOP_INSTRUCTIONS };
  }

  /** A wait that is answered with "stop". Its repeat isn't another call. */
  answeredWait(sessionId: string, callId: string | undefined): void {
    this.db
      .transaction(() => {
        const row = this.row(sessionId);
        const repeated =
          callId !== undefined &&
          this.db
            .prepare(
              "SELECT 1 FROM observed_waits WHERE session_id = ? AND call_id = ? AND stopped = 1",
            )
            .get(sessionId, callId) !== undefined;
        const first = this.answer(row);
        if (callId !== undefined && first)
          this.db
            .prepare(
              `INSERT INTO observed_waits (session_id, call_id, started_at, stopped) VALUES (?, ?, ?, 1)
               ON CONFLICT(session_id, call_id) DO UPDATE SET stopped = 1`,
            )
            .run(sessionId, callId, this.deps.now());
        if (!first && !repeated) this.called(row);
      })
      .immediate();
  }

  /** The connector has the answer of that very wait. */
  finishedWait(sessionId: string, callId: string): void {
    const stopped = this.db
      .prepare(
        "SELECT 1 FROM observed_waits WHERE session_id = ? AND call_id = ? AND stopped = 1",
      )
      .get(sessionId, callId);
    if (stopped) this.received(sessionId);
  }

  /** The connector has the answer. Nothing more is known by it. */
  received(sessionId: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET stop_received_at = ? WHERE id = ? AND state = 'ended' AND end_reason = 'stopped' AND stop_answered_at IS NOT NULL AND stop_received_at IS NULL",
      )
      .run(this.deps.now(), sessionId);
    this.deps.notify();
  }

  /** Another call was refused because of the stop. */
  refusedCall(sessionId: string, requestId: string | undefined): void {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as Row | undefined;
    if (!this.isStopped(row)) return;
    const repeated =
      requestId !== undefined && this.refused.get(sessionId) === requestId;
    if (requestId !== undefined) this.refused.set(sessionId, requestId);
    if (!this.answer(row) && !repeated) this.called(row);
  }

  /** Whether Rejoin may be used for an agent that was stopped. */
  mayRejoin(roomId: number, agentId: string): boolean {
    const row = this.newest(roomId, agentId);
    if (!this.isStopped(row)) return false;
    const since = Math.max(
      row.stop_called_at ?? 0,
      row.stop_received_at !== null && row.stop_called_at === null
        ? 0
        : (row.stop_answered_at ?? row.ended_at ?? 0),
    );
    return this.deps.now() - since >= QUIET_MS;
  }

  /** A new session by an ordinary join, before the old one is replaced. */
  joins(roomId: number, agentId: string): void {
    const row = this.newest(roomId, agentId);
    if (row?.state === "active" && row.stop_asked_at !== null)
      this.deps.logEvent("joined_again_stop_void", roomId, agentId, {});
    else if (this.isStopped(row))
      this.deps.logEvent("joined_after_stop", roomId, agentId, {});
  }

  view(roomId: number, agentId: string): StopView {
    const now = this.deps.now();
    const row = this.newest(roomId, agentId);
    const active = row?.state === "active";
    const asked = active && row.stop_asked_at !== null;
    const stopped = this.isStopped(row);
    const after = asked ? (this.busy(roomId, row) ?? "work") : null;
    const there = active && this.deps.isThere(roomId, agentId);
    const busy = there ? this.busy(roomId, row) : null;
    const since = stopped
      ? (row.stop_called_at ?? row.stop_answered_at ?? row.ended_at!)
      : null;
    const replaced = active
      ? (this.db
          .prepare(
            "SELECT ended_at FROM sessions WHERE room_id = ? AND agent_id = ? AND state = 'replaced' AND stop_asked_at IS NOT NULL ORDER BY rowid DESC LIMIT 1",
          )
          .get(roomId, agentId) as { ended_at: number } | undefined)
      : undefined;
    return {
      can:
        asked || !there
          ? null
          : busy === "turn"
            ? "after_turn"
            : busy === "work"
              ? "after_work"
              : "now",
      state: asked
        ? "asked"
        : !stopped
          ? null
          : row.stop_received_at !== null
            ? "received"
            : row.stop_answered_at !== null
              ? "answered"
              : "undelivered",
      after,
      asked_at: asked || stopped ? row.stop_asked_at : null,
      quiet_since:
        asked && this.deps.isQuiet(roomId, agentId) ? row.last_call_at : null,
      long_ago: since !== null && now - since >= QUIET_MS,
      called_at: stopped ? row.stop_called_at : null,
      joined_again_at:
        replaced && !asked && now - replaced.ended_at < JOINED_SHOWN_MS
          ? replaced.ended_at
          : null,
      holds_lock:
        active &&
        this.db
          .prepare("SELECT 1 FROM write_locks WHERE session_id = ? LIMIT 1")
          .get(row.id) !== undefined,
      open_permission:
        (asked || stopped) &&
        this.db
          .prepare(
            "SELECT 1 FROM permission_requests WHERE room_id = ? AND agent_id = ? AND state = 'pending' LIMIT 1",
          )
          .get(roomId, agentId) !== undefined,
    };
  }

  /** For the room: who was stopped, and whose stop no longer applies. */
  list(
    roomId: number,
    since: number,
  ): { id: number; agent_id: string; created_at: number; kind: string }[] {
    return this.db
      .prepare(
        `SELECT id, agent_id, created_at,
           CASE type WHEN 'stopped' THEN 'stopped' ELSE 'void' END AS kind
         FROM events WHERE room_id = ? AND created_at >= ?
           AND type IN ('stopped', 'joined_again_stop_void') ORDER BY id`,
      )
      .all(roomId, since) as {
      id: number;
      agent_id: string;
      created_at: number;
      kind: string;
    }[];
  }
}
