import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { isMap, isScalar, parseDocument, stringify, type Document } from "yaml";
import { ZodError } from "zod";
import { configPath, parseConfig, type Config } from "./config.js";
import { pathOf, settingFor, type Value } from "./settings.js";

/**
 * Changes named settings in config.yaml and nothing else in it. The page and
 * the command line both use this, one after the other. An editor takes no
 * part: if it saves between the last look and the rename, its save is lost.
 */
export class SettingsError extends Error {
  constructor(
    readonly code:
      "changed" | "broken" | "invalid" | "unknown" | "busy" | "unsafe",
    message: string,
    readonly key?: string,
  ) {
    super(message);
  }
}

export type Read = { text: string; hash: string; stat: Stats };
export type Change = { set?: Record<string, Value>; reset?: string[] };

const KEPT = 5;
const LOCK_MS = 5_000;
const MAX_BYTES = 1024 * 1024;

const hashOf = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const unsafe = (message: string) => new SettingsError("unsafe", message);

/** An ordinary file of this user, never through a link. */
export function readSettingsFile(home: string): Read {
  let file: number;
  try {
    file = openSync(
      configPath(home),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    throw unsafe(
      code === "ELOOP"
        ? "config.yaml is a link; Konfab doesn't change it"
        : `config.yaml can't be read (${code ?? "unknown"})`,
    );
  }
  try {
    const stat = fstatSync(file);
    if (!stat.isFile()) throw unsafe("config.yaml isn't an ordinary file");
    if (stat.size > MAX_BYTES) throw unsafe("config.yaml is too large");
    const text = readFileSync(file, "utf8");
    return { text, hash: hashOf(text), stat };
  } finally {
    closeSync(file);
  }
}

function writable(home: string, stat: Stats): void {
  const uid = process.getuid?.();
  const folder = lstatSync(home);
  if (
    !folder.isDirectory() ||
    (uid !== undefined && (folder.uid !== uid || stat.uid !== uid)) ||
    (process.platform !== "win32" && folder.mode & 0o022) ||
    stat.nlink !== 1
  )
    throw unsafe(
      "config.yaml or its folder isn't only yours; Konfab doesn't change it",
    );
  if (process.platform !== "win32" && !(stat.mode & 0o200))
    throw unsafe("config.yaml is read-only");
}

function parsed(text: string): Document {
  const document = parseDocument(text);
  const error = document.errors[0];
  if (error)
    throw new SettingsError(
      "broken",
      `config.yaml has an error${error.linePos ? ` in line ${error.linePos[0].line}` : ""}: ${error.message.split("\n")[0]}`,
    );
  return document;
}

/** The configuration in a text, or why it can't be used. */
export function checked(text: string): Config {
  parsed(text);
  try {
    return parseConfig(text);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const issue = error.issues[0]!;
    throw new SettingsError(
      "invalid",
      `${issue.path.join(".") || "config.yaml"}: ${issue.message}`,
      issue.path.join("."),
    );
  }
}

type Plain = Record<string, unknown>;

/** The same change on plain values, to compare with. */
function expected(before: unknown, change: Change): unknown {
  // Without what is shared in the file, so that nothing changes along with it.
  const root = JSON.parse(JSON.stringify(before ?? {})) as Plain;
  const parent = (key: string, make: boolean): [Plain, string] | null => {
    const path = pathOf(key);
    let at = root;
    for (const part of path.slice(0, -1)) {
      if (typeof at[part] !== "object" || at[part] === null) {
        if (!make) return null;
        at[part] = {};
      }
      at = at[part] as Plain;
    }
    return [at, path.at(-1)!];
  };
  for (const [key, value] of Object.entries(change.set ?? {})) {
    const [at, name] = parent(key, true)!;
    at[name] = value;
  }
  for (const key of change.reset ?? []) {
    const found = parent(key, false);
    if (!found) continue;
    delete found[0][found[1]];
    const top = pathOf(key)[0]!;
    if (
      pathOf(key).length > 1 &&
      isDeepStrictEqual(root[top], {}) &&
      top !== "agents"
    )
      delete root[top];
  }
  return root;
}

/** The text with the change, the rest as it was, or nothing at all. */
export function edited(text: string, change: Change): string {
  try {
    return edit(text, change);
  } catch (error) {
    // The library refuses what it can't change, such as a shared value.
    throw error instanceof SettingsError ? error : byHand();
  }
}

const byHand = () =>
  unsafe(
    "config.yaml is written in a way that Konfab can't change safely; edit it by hand",
  );

function edit(text: string, change: Change): string {
  const before = parsed(text).toJS() as unknown;
  const wanted = expected(before, change);
  if (isDeepStrictEqual(before ?? {}, wanted)) return text;
  // Plain values first: only their own characters change.
  let simple = text;
  const others: [string, Value][] = [];
  for (const [key, value] of Object.entries(change.set ?? {})) {
    const node = parsed(simple).getIn(pathOf(key), true);
    if (
      isScalar(node) &&
      node.range &&
      node.range[1] > node.range[0] &&
      !node.anchor &&
      !node.tag
    )
      simple =
        simple.slice(0, node.range[0]) +
        stringify(value, { lineWidth: 0 }).trim() +
        simple.slice(node.range[1]);
    else others.push([key, value]);
  }
  const document = parsed(simple);
  const added: Plain = {};
  for (const [key, value] of others) {
    const path = pathOf(key);
    // A new section goes to the very end, after any comments there.
    if (
      path.length === 2 &&
      isMap(document.contents) &&
      !document.has(path[0]!) &&
      !document.contents.flow
    )
      added[path[0]!] = { ...(added[path[0]!] as Plain), [path[1]!]: value };
    else document.setIn(path, value);
  }
  for (const key of change.reset ?? []) {
    const path = pathOf(key);
    if (!document.hasIn(path)) continue;
    document.deleteIn(path);
    const top = document.get(path[0]!);
    if (
      path.length > 1 &&
      path[0] !== "agents" &&
      isMap(top) &&
      !top.items.length
    )
      document.delete(path[0]!);
  }
  // Untouched if there is only something to add.
  const touched =
    others.some(([key]) => !(pathOf(key)[0]! in added)) ||
    (change.reset?.length ?? 0) > 0;
  let next = touched ? document.toString({ lineWidth: 0 }) : simple;
  if (Object.keys(added).length)
    next = `${next.trimEnd()}${next.trim() ? "\n\n" : ""}${stringify(added)}`;
  if (/\r\n/.test(text)) next = next.replace(/\r?\n/g, "\r\n");
  let result: unknown;
  try {
    result = parsed(next).toJS();
  } catch {
    result = undefined;
  }
  if (!isDeepStrictEqual(result, wanted)) throw byHand();
  return next;
}

/** One writer at a time; the system ends it with the process. */
async function withLock<T>(home: string, action: () => T): Promise<T> {
  const lock = new Database(join(home, "config.lock"), { timeout: 0 });
  try {
    const until = Date.now() + LOCK_MS;
    for (;;) {
      try {
        lock.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!/^SQLITE_BUSY/.test((error as { code?: string }).code ?? ""))
          throw error;
        if (Date.now() >= until)
          throw new SettingsError(
            "busy",
            "Another change is being saved; try again",
          );
        await new Promise((done) => setTimeout(done, 50));
      }
    }
    try {
      return action();
    } finally {
      lock.exec("ROLLBACK");
    }
  } finally {
    lock.close();
  }
}

function keep(home: string, text: string): void {
  const folder = join(home, "backups", "config");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.yaml`;
  write(join(folder, name), text);
  for (const old of readdirSync(folder)
    .filter((file) => file.endsWith(".yaml"))
    .sort()
    .slice(0, -KEPT))
    rmSync(join(folder, old), { force: true });
}

function write(path: string, text: string): void {
  const file = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(file, text);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

/**
 * `hash`: of the file that was shown. Returns the new one's. `between` is a
 * test seam: right before the last look, and right after it.
 */
export async function changeSettings(
  home: string,
  change: Change,
  hash?: string,
  between: { look?: () => void; rename?: () => void } = {},
): Promise<{ hash: string; config: Config; changed: boolean }> {
  for (const key of [...Object.keys(change.set ?? {}), ...(change.reset ?? [])])
    if (!settingFor(key))
      throw new SettingsError("unknown", `${key} isn't a setting`, key);
  return withLock(home, () => {
    const before = readSettingsFile(home);
    const moved = () =>
      new SettingsError("changed", "The file has changed meanwhile");
    if (hash !== undefined && before.hash !== hash) throw moved();
    writable(home, before.stat);
    const text = edited(before.text, change);
    const config = checked(text);
    if (text === before.text)
      return { hash: before.hash, config, changed: false };
    const temporary = join(home, `.config-${randomUUID()}.tmp`);
    try {
      write(temporary, text);
      keep(home, before.text);
      between.look?.();
      const again = readSettingsFile(home);
      if (again.hash !== before.hash || again.stat.ino !== before.stat.ino)
        throw moved();
      between.rename?.();
      renameSync(temporary, configPath(home));
    } finally {
      rmSync(temporary, { force: true });
    }
    return { hash: hashOf(text), config, changed: true };
  });
}

/** Left by a process that died while it saved. */
export function tidySettingsFiles(home: string): void {
  for (const name of readdirSync(home))
    if (/^\.config-[0-9a-f-]{36}\.tmp$/.test(name))
      rmSync(join(home, name), { force: true });
}
