import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import Database from "better-sqlite3";

export const LOG_NAME = "konfab.log";
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Older files kept beside the current one: konfab.log.1 is the newest. */
export const LOG_KEEP = 3;
const LINE_MAX_BYTES = 64 * 1024;
const RETRY_MS = 60_000;

/** What a login item prints, such as a crash. */
export const OUTPUT_NAME = "output.log";

export const logDirectory = (home: string): string => join(home, "logs");

type Options = {
  name?: string;
  maxBytes?: number;
  keep?: number;
  now?: () => number;
  /** Told once about each problem. */
  warn?: (message: string) => void;
};

/**
 * The server's log, in a bounded number of files that only this user can
 * read. Only one process writes or rotates them at a time. A problem with the
 * log never stops Konfab: lines are dropped, and writing is tried again a
 * minute later. Files with other names are never touched.
 */
export class LogFile extends Writable {
  readonly path: string;
  private fd: number | null = null;
  private lock: Database.Database | null = null;
  private size = 0;
  private retryAt = 0;
  private warned = false;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly directory: string,
    options: Options = {},
  ) {
    super({ decodeStrings: true });
    this.path = join(directory, options.name ?? LOG_NAME);
    this.maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
    this.keep = options.keep ?? LOG_KEEP;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((message) => console.error(message));
    this.attempt(() => this.open());
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.attempt(() => {
      if (this.fd === null) this.open();
      // One huge line must not break the limit.
      const line =
        chunk.length > LINE_MAX_BYTES
          ? Buffer.from(
              `${JSON.stringify({ level: 40, time: this.now(), msg: `A log line of ${chunk.length} bytes was left out` })}\n`,
            )
          : chunk;
      if (this.size > 0 && this.size + line.length > this.maxBytes)
        this.rotate();
      for (let at = 0; at < line.length;)
        at += writeSync(this.fd as number, line, at);
      this.size += line.length;
    });
    done();
  }

  override _destroy(
    error: Error | null,
    done: (error?: Error | null) => void,
  ): void {
    this.close();
    this.lock?.close();
    this.lock = null;
    done(error);
  }

  private attempt(action: () => void): void {
    if (this.now() < this.retryAt) return;
    try {
      action();
      this.retryAt = 0;
      this.warned = false;
    } catch (error) {
      this.close();
      this.retryAt = this.now() + RETRY_MS;
      // Once per problem: this goes where nothing rotates it.
      if (this.warned) return;
      this.warned = true;
      this.warn(
        `Konfab can't write its log (${this.path}): ${(error as Error).message}. Konfab keeps running and tries again in a minute.`,
      );
    }
  }

  private open(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.directory).isDirectory())
      throw new Error("the logs folder isn't a folder");
    chmodSync(this.directory, 0o700);
    this.takeLock();
    const fd = openSync(
      this.path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        // Never through a link, and never waiting on something else.
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
      0o600,
    );
    const info = fstatSync(fd);
    if (!info.isFile()) {
      closeSync(fd);
      throw new Error("it isn't a regular file");
    }
    this.fd = fd;
    this.size = info.size;
    chmodSync(this.path, 0o600);
    if (this.size >= this.maxBytes) this.rotate();
  }

  /** Held until this process ends, also by a crash; another can't rotate. */
  private takeLock(): void {
    if (this.lock) return;
    const path = `${this.path}.lock`;
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing && !existing.isFile())
      throw new Error("its lock isn't a regular file");
    const lock = new Database(path, { timeout: 0 });
    try {
      chmodSync(path, 0o600);
      // Nothing is stored in it, so no file beside it either.
      lock.pragma("journal_mode = MEMORY");
      lock.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      lock.close();
      throw (error as { code?: string }).code === "SQLITE_BUSY"
        ? new Error("another Konfab is writing it")
        : error;
    }
    this.lock = lock;
  }

  private rotate(): void {
    this.close();
    const old = (number: number) => `${this.path}.${number}`;
    rmSync(old(this.keep), { force: true });
    for (let number = this.keep - 1; number >= 1; number -= 1)
      this.move(old(number), old(number + 1));
    this.move(this.path, old(1));
    this.open();
  }

  private move(from: string, to: string): void {
    try {
      renameSync(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // Nothing left to close.
    }
    this.fd = null;
  }
}
