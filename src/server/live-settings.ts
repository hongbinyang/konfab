import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { configPath, type Config } from "./config.js";
import { checked, readSettingsFile, SettingsError } from "./settings-file.js";
import { LIVE, notInUse } from "./settings.js";

const LOOK_MS = 2_000;
const TOUCH_MS = 8_000;
const FRESH_MS = 25_000;

/** What the running server says about itself, for the command line. */
export type InUse = {
  pid: number;
  port: number;
  started_at: number;
  seen_at: number;
  /** Of the file that was read last, and whether it could be used. */
  hash: string;
  problem: string | null;
  /** Saved, but not in use before a restart. */
  waiting: string[];
};

const notePath = (home: string) => join(home, "in-use.json");

/**
 * The configuration of a running server. It looks at the file now and then;
 * one that can't be used changes nothing.
 */
export class LiveSettings {
  /** As at the start, with the parts that are taken on since. */
  inUse: Config;
  saved: Config;
  hash: string;
  problem: string | null = null;
  private stamp = "";
  private touched = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly startedAt = Date.now();

  constructor(
    private readonly deps: {
      home: string;
      port: number;
      apply: (config: Config, before: Config) => void;
      changed: () => void;
      warn: (message: string) => void;
    },
    start: { config: Config; hash: string },
  ) {
    this.inUse = start.config;
    this.saved = start.config;
    this.hash = start.hash;
  }

  start(): void {
    this.look();
    this.timer = setInterval(() => this.look(), LOOK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    rmSync(notePath(this.deps.home), { force: true });
  }

  /** Now: after a save, and before the page shows the values. */
  look(force = false): void {
    let stamp: string;
    try {
      const info = statSync(configPath(this.deps.home));
      stamp = [info.dev, info.ino, info.size, info.mtimeMs].join(":");
    } catch {
      stamp = "missing";
    }
    if (force || stamp !== this.stamp) {
      this.stamp = stamp;
      this.read();
    } else if (Date.now() - this.touched >= TOUCH_MS) this.note();
  }

  private read(): void {
    const before = [this.hash, this.problem, this.saved] as const;
    try {
      const { text, hash } = readSettingsFile(this.deps.home);
      this.hash = hash;
      const config = checked(text);
      this.problem = null;
      this.saved = config;
      const next = { ...this.inUse };
      for (const part of LIVE) Object.assign(next, { [part]: config[part] });
      if (!isDeepStrictEqual(next, this.inUse)) {
        const old = this.inUse;
        this.inUse = next;
        this.deps.apply(next, old);
      }
    } catch (error) {
      this.problem =
        error instanceof SettingsError
          ? error.message
          : "config.yaml can't be used";
      if (this.problem !== before[1])
        this.deps.warn(`Settings: ${this.problem}. The earlier ones stay.`);
    }
    this.note();
    if (
      before[0] !== this.hash ||
      before[1] !== this.problem ||
      !isDeepStrictEqual(before[2], this.saved)
    )
      this.deps.changed();
  }

  waiting(): string[] {
    return notInUse(this.saved, this.inUse);
  }

  private note(): void {
    this.touched = Date.now();
    const note: InUse = {
      pid: process.pid,
      port: this.deps.port,
      started_at: this.startedAt,
      seen_at: this.touched,
      hash: this.hash,
      problem: this.problem,
      waiting: this.waiting(),
    };
    const path = notePath(this.deps.home);
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      rmSync(temporary, { force: true });
      const file = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(file, JSON.stringify(note));
      } finally {
        closeSync(file);
      }
      renameSync(temporary, path);
    } catch {
      // The command line then says that it doesn't know.
    }
  }
}

/** The running server of this folder, or why nothing is known of it. */
export function readInUse(
  home: string,
  now = Date.now(),
  alive: (pid: number) => boolean = isAlive,
): InUse | "none" | "unsure" {
  let note: InUse;
  try {
    note = JSON.parse(readFileSync(notePath(home), "utf8")) as InUse;
    if (!Number.isSafeInteger(note.pid) || typeof note.hash !== "string")
      return "unsure";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "none"
      : "unsure";
  }
  if (!alive(note.pid)) return "none";
  return now - note.seen_at < FRESH_MS && note.seen_at <= now + FRESH_MS
    ? note
    : "unsure";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
