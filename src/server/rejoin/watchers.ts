import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/index.js";
import {
  conversationId,
  type RejoinRequests,
  type SendResult,
} from "../domain/rejoin.js";
import type { Processes } from "./processes.js";

/**
 * Brings a Claude agent back: it started a command that waits silently, and
 * the app starts its conversation again when that command ends. Everything
 * here is about who is told a request number, at most once, and about never
 * having more such commands than places. See docs/design/rejoin-claude.md.
 */

export const TICKET_PREFIX = "kfw_";
const TICKET = /^kfw_[A-Za-z0-9_-]{22,43}$/;
const ISSUED_MS = 2 * 60_000;
const LIFE_MS = 7 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const OPEN_MS = 25_000;
const FIND_OPEN_MS = 5_000;
const GAP_MS = 5_000;
const PRINTED_MS = 10_000;
const PER_CONVERSATION = 3;
const PER_APP = 6;
const PER_DAY = 20;
const LEAVES_PER_DAY = 2;
const SOON_MS = 60_000;
const WRONG_PER_MINUTE = 20;

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const random = (): string => randomBytes(20).toString("base64url");

type Row = {
  id: number;
  app_id: string;
  agent_id: string;
  conversation_id: string;
  ticket_hash: string | null;
  state: "issued" | "live" | "used" | "ended" | "gone";
  created_at: number;
  pid: number | null;
  process_start: string | null;
  boot: string | null;
  request_id: number | null;
  handover_hash: string | null;
  printed_at: number | null;
  left_at: number | null;
};

export type WatchAnswer =
  | { status: "wait" }
  | { status: "print"; request: string; handover: string }
  | { status: "rest" }
  | { status: "leave" };

export type WatchOffer =
  { command: string; instructions: string } | { running: true };

export type WatcherState = {
  /** A call is open now, so a request can be handed over. */
  ready: boolean;
  /** Started earlier and, as far as is known, still there. */
  resting: number;
  full: boolean;
};

const INSTRUCTIONS =
  "Start this command once, in the background, exactly as given. Don't look at its output while it runs. When it ends and printed a request, call rejoin_room with that request; when it printed anything else, end your turn and start nothing. If the user interrupted you in this app, with its own Stop button, and hasn't written since, don't come back with it: call rejoin_room with \"declined \" and then the request, which only tells the lead, end your turn and say so. A stop that came from Konfab, as the answer of a call, is different: the lead's request comes after it, so use it.";

export class RefusedWatch extends Error {}

type Open = { answer: (answer: WatchAnswer) => void };

export class Watchers {
  enabled = false;
  private readonly open = new Map<number, Open>();
  /** When a call was last open: between two calls there is a short gap. */
  private readonly lastOpen = new Map<number, number>();
  private readonly changed = new Set<() => void>();
  private readonly printedWaits = new Map<number, () => void>();
  private wrong: number[] = [];

  constructor(
    private readonly deps: {
      db: Db;
      rejoin: RejoinRequests;
      /** Holds the tickets' files; inside Konfab's own folder. */
      folder: string;
      /** The built watch.js, and the Node that runs it. */
      script: string;
      node: string;
      port: number;
      uid: number;
      processes: Processes;
      now?: () => number;
      /** Its wait_for_turn call is open in that conversation. */
      isWaiting: (agentId: string, conversation: string) => boolean;
      changed?: () => void;
    },
  ) {}

  private get db(): Db {
    return this.deps.db;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private file(id: number): string {
    return join(this.deps.folder, String(id));
  }

  private removeFile(id: number): void {
    rmSync(this.file(id), { force: true });
  }

  /**
   * In a running server. Off: nothing is told a request any more, and armed
   * ones rest at once. On again doesn't bring them back.
   */
  turn(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this.tidy();
    if (on) return;
    for (const call of [...this.open.values()]) call.answer({ status: "wait" });
    for (const listener of this.changed) listener();
  }

  /** After a start, and now and then. */
  tidy(): void {
    const now = this.now();
    this.db
      .prepare(
        "UPDATE watchers SET state = 'ended' WHERE state = 'live' AND created_at <= ?",
      )
      .run(now - LIFE_MS);
    if (!this.enabled)
      this.db
        .prepare("UPDATE watchers SET state = 'ended' WHERE state = 'live'")
        .run();
    // Nothing has called with it, so nothing that runs can use it any more.
    this.db
      .prepare(
        "UPDATE watchers SET state = 'gone', ticket_hash = NULL WHERE pid IS NULL AND state <> 'gone' AND (state <> 'issued' OR created_at <= ? OR created_at > ? OR ?)",
      )
      .run(now - ISSUED_MS, now, this.enabled ? 0 : 1);
    const issued = new Set(
      (
        this.db
          .prepare("SELECT id FROM watchers WHERE state = 'issued'")
          .all() as { id: number }[]
      ).map((row) => String(row.id)),
    );
    let names: string[] = [];
    try {
      names = readdirSync(this.deps.folder);
    } catch {
      // Not made yet.
    }
    for (const name of names)
      if (!issued.has(name))
        rmSync(join(this.deps.folder, name), { force: true, recursive: false });
  }

  /** Only proof frees a place; whatever isn't clear keeps it. */
  private freeGone(): void {
    const rows = this.db
      .prepare(
        "SELECT * FROM watchers WHERE state IN ('live','used','ended') AND pid IS NOT NULL",
      )
      .all() as Row[];
    if (!rows.length) return;
    const boot = this.deps.processes.boot();
    for (const row of rows) {
      let gone = boot !== null && row.boot !== null && boot !== row.boot;
      if (!gone) {
        const looked = this.deps.processes.look(row.pid!);
        gone =
          looked === "none" ||
          (looked !== "unknown" && looked.start !== row.process_start);
      }
      if (gone)
        this.db
          .prepare(
            "UPDATE watchers SET state = 'gone', ticket_hash = NULL, handover_hash = NULL WHERE id = ?",
          )
          .run(row.id);
    }
  }

  private taken(where: string, ...values: unknown[]): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM watchers WHERE state <> 'gone' AND ${where}`,
        )
        .get(...values) as { n: number }
    ).n;
  }

  private isFull(appId: string, agentId: string, conversation: string) {
    return (
      this.taken("app_id = ?", appId) >= PER_APP ||
      this.taken("conversation_id = ?", conversation) >= PER_CONVERSATION ||
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM watchers WHERE agent_id = ? AND created_at > ?",
          )
          .get(agentId, this.now() - DAY_MS) as { n: number }
      ).n >= PER_DAY
    );
  }

  private current(agentId: string, conversation: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT * FROM watchers WHERE agent_id = ? AND conversation_id = ? AND state IN ('issued','live')",
      )
      .get(agentId, conversation) as Row | undefined;
  }

  /** For the answer of a join: what to start, if anything. */
  offer(
    appId: string,
    agentId: string,
    value: unknown,
  ): WatchOffer | undefined {
    const conversation = conversationId(value);
    if (!this.enabled || !conversation) return undefined;
    this.sawWakeUp(conversation);
    return this.db
      .transaction((): WatchOffer | undefined => {
        this.tidy();
        let current = this.current(agentId, conversation);
        if (current?.state === "live") {
          this.freeGone();
          current = this.current(agentId, conversation);
          if (current?.state === "live") return { running: true };
        }
        if (current) return this.answerFor(current.id);
        if (this.isFull(appId, agentId, conversation)) {
          this.freeGone();
          if (this.isFull(appId, agentId, conversation)) return undefined;
        }
        const ticket = TICKET_PREFIX + random();
        const id = Number(
          this.db
            .prepare(
              "INSERT INTO watchers (app_id, agent_id, conversation_id, ticket_hash, state, created_at) VALUES (?, ?, ?, ?, 'issued', ?)",
            )
            .run(appId, agentId, conversation, hash(ticket), this.now())
            .lastInsertRowid,
        );
        this.writeFile(id, ticket);
        return this.answerFor(id);
      })
      .immediate();
  }

  private answerFor(id: number): WatchOffer {
    const quote = (part: string) => `'${part.replaceAll("'", `'\\''`)}'`;
    return {
      command: [this.deps.node, this.deps.script, this.file(id)]
        .map(quote)
        .join(" "),
      instructions: INSTRUCTIONS,
    };
  }

  /** In a folder only this user can open; never through a link. */
  private writeFile(id: number, ticket: string): void {
    mkdirSync(this.deps.folder, { recursive: true, mode: 0o700 });
    const folder = lstatSync(this.deps.folder);
    if (
      !folder.isDirectory() ||
      folder.uid !== this.deps.uid ||
      folder.mode & 0o077
    )
      throw new Error("The folder of the watch tickets isn't private");
    const file = openSync(
      this.file(id),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(file, 0o600);
      const info = fstatSync(file);
      if (info.uid !== this.deps.uid || info.nlink !== 1)
        throw new Error("The watch ticket's file isn't private");
      writeSync(file, JSON.stringify({ ticket, port: this.deps.port }));
    } finally {
      closeSync(file);
    }
  }

  private find(ticket: unknown): Row {
    const now = this.now();
    this.wrong = this.wrong.filter((at) => at > now - 60_000 && at <= now);
    if (this.wrong.length >= WRONG_PER_MINUTE) throw new RefusedWatch();
    const row =
      typeof ticket === "string" && TICKET.test(ticket)
        ? (this.db
            .prepare("SELECT * FROM watchers WHERE ticket_hash = ?")
            .get(hash(ticket)) as Row | undefined)
        : undefined;
    if (!row || row.state === "gone") {
      this.wrong.push(now);
      throw new RefusedWatch();
    }
    return row;
  }

  /**
   * The first call binds the ticket to the process, which must be this user's
   * watch.js with this ticket's file. Anything unclear: refused.
   */
  private bind(row: Row, pid: number): void {
    const looked = this.deps.processes.look(pid);
    const boot = this.deps.processes.boot();
    if (
      looked === "none" ||
      looked === "unknown" ||
      boot === null ||
      looked.uid !== this.deps.uid ||
      !looked.command.endsWith(` ${this.deps.script} ${this.file(row.id)}`)
    )
      throw new RefusedWatch();
    const bound = this.db
      .prepare(
        "UPDATE watchers SET state = 'live', pid = ?, process_start = ?, boot = ? WHERE id = ? AND state = 'issued' AND created_at > ? AND created_at <= ?",
      )
      .run(pid, looked.start, boot, row.id, this.now() - ISSUED_MS, this.now());
    if (bound.changes !== 1) throw new RefusedWatch();
    this.removeFile(row.id);
  }

  /** One held call of a watcher. `gone` says that its connection broke. */
  async watch(
    ticket: unknown,
    pid: unknown,
    gone: AbortSignal,
  ): Promise<WatchAnswer> {
    let row = this.find(ticket);
    if (typeof pid !== "number" || !Number.isSafeInteger(pid))
      throw new RefusedWatch();
    if (row.state === "issued") {
      if (!this.enabled) throw new RefusedWatch();
      this.bind(row, pid);
      row = this.find(ticket);
    }
    if (row.pid !== pid) throw new RefusedWatch();
    if (row.state === "live" && !this.enabled) {
      this.db
        .prepare("UPDATE watchers SET state = 'ended' WHERE id = ?")
        .run(row.id);
      row = this.find(ticket);
    }
    if (row.state !== "live") return this.restOrLeave(row);
    const { id } = row;
    this.open.get(id)?.answer({ status: "wait" });
    return new Promise<WatchAnswer>((done) => {
      const finish = (answer: WatchAnswer) => {
        clearTimeout(timer);
        gone.removeEventListener("abort", lost);
        if (this.open.get(id) === mine) {
          this.open.delete(id);
          this.lastOpen.set(id, this.now());
          setTimeout(() => {
            if (!this.isOpen(id)) this.deps.changed?.();
          }, GAP_MS + 100).unref();
        }
        done(answer);
      };
      const lost = () => finish({ status: "wait" });
      const timer = setTimeout(lost, OPEN_MS);
      const mine: Open = { answer: finish };
      const wasOpen = this.isOpen(id);
      this.open.set(id, mine);
      if (gone.aborted) return lost();
      gone.addEventListener("abort", lost, { once: true });
      if (!wasOpen) this.deps.changed?.();
      for (const listener of this.changed) listener();
    });
  }

  private restOrLeave(row: Row): WatchAnswer {
    const now = this.now();
    if (row.left_at !== null) return { status: "leave" };
    // Its end could wake its conversation, so not while this is off.
    if (!this.enabled) return { status: "rest" };
    if (!this.deps.isWaiting(row.agent_id, row.conversation_id))
      return { status: "rest" };
    const recent = this.db
      .prepare(
        "SELECT COUNT(*) AS n, MAX(left_at) AS last, MAX(cleanup_off) AS off FROM watchers WHERE conversation_id = ? AND (left_at > ? OR cleanup_off = 1)",
      )
      .get(row.conversation_id, now - DAY_MS) as {
      n: number;
      last: number | null;
      off: number | null;
    };
    if (
      recent.off ||
      recent.n >= LEAVES_PER_DAY ||
      (recent.last !== null && recent.last > now - SOON_MS)
    )
      return { status: "rest" };
    this.db
      .prepare("UPDATE watchers SET left_at = ? WHERE id = ?")
      .run(now, row.id);
    return { status: "leave" };
  }

  /** A join soon after a clean-up: it may have woken the conversation. */
  private sawWakeUp(conversation: string): void {
    this.db
      .prepare(
        "UPDATE watchers SET cleanup_off = 1 WHERE conversation_id = ? AND left_at > ?",
      )
      .run(conversation, this.now() - SOON_MS);
  }

  /** The watcher wrote the whole line, and the system took it. */
  printed(ticket: unknown, handover: unknown): void {
    const row = this.find(ticket);
    if (
      row.state !== "used" ||
      typeof handover !== "string" ||
      row.handover_hash !== hash(handover)
    )
      throw new RefusedWatch();
    if (row.printed_at !== null) return;
    this.db
      .prepare("UPDATE watchers SET printed_at = ? WHERE id = ?")
      .run(this.now(), row.id);
    this.deps.rejoin.sure(row.request_id!);
    this.printedWaits.get(row.id)?.();
  }

  private isOpen(id: number): boolean {
    const last = this.lastOpen.get(id);
    return (
      this.open.has(id) ||
      (last !== undefined && this.now() - last < GAP_MS && this.now() >= last)
    );
  }

  private openRow(agentId: string, conversation: string): Row | undefined {
    const row = this.current(agentId, conversation);
    return row?.state === "live" && this.open.has(row.id) ? row : undefined;
  }

  state(appId: string, agentId: string, conversation: string): WatcherState {
    const current = this.current(agentId, conversation);
    return {
      ready:
        this.enabled && current?.state === "live" && this.isOpen(current.id),
      resting: this.taken(
        "conversation_id = ? AND state IN ('used','ended')",
        conversation,
      ),
      full: !current && this.isFull(appId, agentId, conversation),
    };
  }

  /** Hands the request over on an open call, at most once. */
  async send(asked: {
    id: number;
    number: string;
    agent: string;
    conversation: string;
  }): Promise<SendResult> {
    const row = await this.waitForOpen(asked.agent, asked.conversation);
    if (!row) return "refused";
    const handover = random();
    const call = this.open.get(row.id);
    if (!call) return "refused";
    const handed = this.db
      .transaction(() => {
        if (!this.enabled) return false;
        const fresh = this.current(asked.agent, asked.conversation);
        if (fresh?.id !== row.id || fresh.state !== "live") return false;
        if (!this.deps.rejoin.mayHandOver(asked.id, fresh)) return false;
        this.db
          .prepare(
            "UPDATE watchers SET state = 'used', request_id = ?, handover_hash = ? WHERE id = ?",
          )
          .run(asked.id, hash(handover), row.id);
        return true;
      })
      .immediate();
    if (!handed) return "refused";
    const printed = new Promise<boolean>((done) => {
      const timer = setTimeout(() => finish(false), PRINTED_MS);
      const finish = (value: boolean) => {
        clearTimeout(timer);
        this.printedWaits.delete(row.id);
        done(value);
      };
      this.printedWaits.set(row.id, () => finish(true));
    });
    call.answer({ status: "print", request: asked.number, handover });
    return (await printed) ? "taken" : "unsure";
  }

  private async waitForOpen(
    agentId: string,
    conversation: string,
  ): Promise<Row | undefined> {
    if (!this.enabled) return undefined;
    const now = this.openRow(agentId, conversation);
    if (now) return now;
    return new Promise((done) => {
      const finish = (row: Row | undefined) => {
        clearTimeout(timer);
        this.changed.delete(look);
        done(row);
      };
      const look = () => {
        const row = this.openRow(agentId, conversation);
        if (row) finish(row);
      };
      const timer = setTimeout(() => finish(undefined), FIND_OPEN_MS);
      this.changed.add(look);
    });
  }
}
