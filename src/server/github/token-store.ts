import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../settings-file.js";
import { readJson, writeJson } from "../telegram/store.js";
import {
  GITHUB,
  keptIn,
  newGithubItem,
  type Keychain,
  type TokenRead,
} from "../telegram/token.js";

/**
 * The GitHub token for the skill search. As for the bot's token: every store
 * makes a new place, which comes into use only when the pointer names it, in
 * one step in the lock. The place of earlier versions is used while there is
 * no pointer, and never deleted without a question. See
 * docs/design/settings-phase3.md.
 */
export type GithubSource = "environment" | "stored" | "earlier" | "none";

export type GithubTokenView = {
  source: GithubSource;
  /** Where a stored one is kept; null where nothing can be stored. */
  kept: "keychain" | "file" | null;
  /** Whether it could be read when it was last looked at. */
  readable: boolean;
  /** An earlier version's place, which another Konfab folder may use. */
  earlier_left: boolean;
  /** Places this folder made that aren't in use, which may still be there. */
  left_over: string[];
};

type Pointer = { item: string | null };
type Note = { item: string; state: "storing" | "ready" | "unknown" | "unused" };

const EARLIER = "konfab-github-token";
const pointerPath = (home: string) => join(home, "github-token.json");
const notesPath = (home: string) => join(home, "github-notes.json");

/** Asks GitHub whose token it is; only GitHub sees it. */
export const githubAccepts = async (token: string): Promise<boolean> =>
  (
    await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Konfab",
      },
      signal: AbortSignal.timeout(15_000),
    })
  ).status === 200;

/** Undefined: no pointer at all, as before this version. */
export function readPointer(home: string): Pointer | undefined {
  try {
    statSync(pointerPath(home));
  } catch {
    return undefined;
  }
  const value = readJson(pointerPath(home)) as Partial<Pointer> | null;
  // One that can't be read names nothing: never the earlier place.
  return {
    item:
      typeof value?.item === "string" && GITHUB.own.test(value.item)
        ? value.item
        : null,
  };
}

const stampOf = (home: string): string => {
  try {
    return readFileSync(pointerPath(home), "utf8");
  } catch {
    return "";
  }
};

function readNotes(home: string): Note[] {
  const value = readJson(notesPath(home)) as { notes?: unknown } | null;
  return Array.isArray(value?.notes)
    ? (value.notes as Note[]).filter(
        (note) =>
          typeof note?.item === "string" &&
          GITHUB.own.test(note.item) &&
          ["storing", "ready", "unknown", "unused"].includes(note.state),
      )
    : [];
}
function writeNotes(home: string, notes: Note[]): void {
  if (notes.length) writeJson(notesPath(home), { notes });
  else rmSync(notesPath(home), { force: true });
}
const note = (home: string, item: string, state: Note["state"] | null) =>
  withLock(home, () => {
    const notes = readNotes(home).filter((one) => one.item !== item);
    writeNotes(home, state ? [...notes, { item, state }] : notes);
  });

export class GithubToken {
  /** What searches use; changed only after a commit or a look. */
  token: string | undefined;
  source: GithubSource = "none";
  readable = true;
  private stamp: string | null = null;

  constructor(
    private readonly deps: {
      home: string;
      keychain: Pick<
        Keychain,
        "usable" | "kept" | "fromEnvironment" | "read" | "store" | "remove"
      >;
      env: NodeJS.ProcessEnv;
      /** Whether GitHub takes the token. A stand-in in tests. */
      accepts: (token: string) => Promise<boolean>;
      changed: (token: string | undefined) => void;
    },
  ) {}

  private set(token: string | undefined, source: GithubSource): void {
    const before = this.token;
    this.token = token;
    this.source = source;
    if (before !== token) this.deps.changed(token);
  }

  /** At the start, and when the pointer changed, also by another program. */
  async load(): Promise<void> {
    const { home, keychain, env } = this.deps;
    this.stamp = stampOf(home);
    const fromEnv = env[GITHUB.env]?.trim();
    if (fromEnv) return this.set(fromEnv, "environment");
    if (!keychain.usable) return this.set(undefined, "none");
    const pointer = readPointer(home);
    if (pointer && pointer.item === null) return this.set(undefined, "none");
    const item = pointer?.item ?? EARLIER;
    let read: TokenRead = { state: "unknown" };
    try {
      read = await keychain.read({ slot: "own", item });
    } catch {
      // Unknown.
    }
    // Changed again meanwhile: the next look reads it.
    if (stampOf(home) !== this.stamp) return;
    this.readable = read.state !== "unknown";
    if (read.state === "found")
      return this.set(read.token, pointer ? "stored" : "earlier");
    // A place that can't be read now keeps the token that searches have.
    if (read.state === "none") this.set(undefined, "none");
  }

  /** Cheap; done every few seconds. */
  async look(): Promise<void> {
    if (stampOf(this.deps.home) !== this.stamp) await this.load();
  }

  view(): GithubTokenView {
    const pointer = readPointer(this.deps.home);
    return {
      source: this.source,
      kept: this.deps.keychain.usable ? this.deps.keychain.kept : null,
      readable: this.readable,
      earlier_left:
        this.deps.keychain.kept === "keychain" && pointer !== undefined,
      left_over: readNotes(this.deps.home)
        .filter((one) => one.item !== pointer?.item)
        .map((one) => one.item),
    };
  }

  /**
   * A new token, from the page or the terminal. Nothing changes for searches
   * until it is checked, stored, read back equal and named by the pointer.
   */
  async store(token: string): Promise<void> {
    const { home, keychain } = this.deps;
    const typed = token.trim();
    // What it replaces: anything newer, also during the check, is kept.
    const began = stampOf(home);
    if (!GITHUB.pattern.test(typed))
      throw new GithubTokenError("That isn't a GitHub token.");
    if (this.deps.env[GITHUB.env])
      throw new GithubTokenError(
        "KONFAB_GITHUB_TOKEN is set, so it would be used instead. Change it there.",
      );
    if (!keychain.usable)
      throw new GithubTokenError(
        "Nothing can be stored on this computer; set KONFAB_GITHUB_TOKEN instead.",
      );
    let accepted: boolean;
    try {
      accepted = await this.deps.accepts(typed);
    } catch {
      throw new GithubTokenError(
        "GitHub can't be reached to check the token. Nothing was changed.",
      );
    }
    if (!accepted)
      throw new GithubTokenError(
        "GitHub didn't accept this token. Nothing was changed.",
      );
    const item = newGithubItem();
    await note(home, item, "storing");
    try {
      await keychain.store(item, typed);
    } catch {
      // Reading it back says what became of it.
    }
    let read: TokenRead = { state: "unknown" };
    try {
      read = await keychain.read({ slot: "own", item });
    } catch {
      // Unknown.
    }
    const window =
      keychain.kept === "keychain"
        ? " If a macOS window is still open, press Cancel there."
        : "";
    if (read.state === "none") {
      await note(home, item, null);
      throw new GithubTokenError(
        `The token wasn't saved.${window} Nothing was changed.`,
      );
    }
    if (read.state !== "found" || read.token !== typed) {
      await note(home, item, "unknown");
      throw new GithubTokenError(
        `It isn't known whether the token was saved.${window} Nothing was changed.`,
      );
    }
    const old = await withLock(home, () => {
      if (stampOf(home) !== began) return false;
      const before = readPointer(home)?.item ?? null;
      writeJson(pointerPath(home), { item });
      const notes = readNotes(home)
        .filter((one) => one.item !== item)
        .map((one) =>
          one.item === before ? { ...one, state: "unused" as const } : one,
        );
      if (before && !notes.some((one) => one.item === before))
        notes.push({ item: before, state: "unused" });
      writeNotes(home, notes);
      return before ?? null;
    });
    if (old === false) {
      await note(home, item, "unused");
      throw new GithubTokenError(
        "The GitHub token was changed meanwhile. Nothing was changed here.",
      );
    }
    this.stamp = stampOf(home);
    this.readable = true;
    this.set(typed, "stored");
    // Searches hold the token itself, so deleting the old place can't fail one.
    if (old) await this.forget(old);
  }

  /**
   * Not used any more: the pointer names nothing, which never falls back to
   * the earlier place. That one is deleted only when the lead says so.
   */
  async remove(earlier: boolean): Promise<void> {
    const { home } = this.deps;
    const old = await withLock(home, () => {
      const before = readPointer(home)?.item ?? null;
      writeJson(pointerPath(home), { item: null });
      if (before)
        writeNotes(home, [
          ...readNotes(home).filter((one) => one.item !== before),
          { item: before, state: "unused" },
        ]);
      return before;
    });
    this.stamp = stampOf(home);
    if (this.source !== "environment") this.set(undefined, "none");
    if (old) await this.forget(old);
    if (earlier) await this.removeEarlier();
  }

  /**
   * The earlier version's place, which another folder may use: only after the
   * lead's yes, and only while this folder doesn't use it.
   */
  async removeEarlier(): Promise<void> {
    const { home, keychain } = this.deps;
    if (keychain.kept !== "keychain") return;
    if (readPointer(home) === undefined)
      throw new GithubTokenError(
        "The earlier token is the one in use; remove that first.",
      );
    const result = await keychain.remove(EARLIER);
    if (result === "unknown")
      throw new GithubTokenError(
        `It isn't known whether the earlier token was removed. Its name in Keychain Access is ${EARLIER}.`,
      );
  }

  /** Only a place this folder made, and only once it is unused. */
  async forget(item: string): Promise<boolean> {
    const { home, keychain } = this.deps;
    const given = await withLock(home, () => {
      if (readPointer(home)?.item === item) return false;
      const notes = readNotes(home);
      if (!notes.some((one) => one.item === item)) return false;
      writeNotes(
        home,
        notes.map((one) =>
          one.item === item ? { ...one, state: "unused" as const } : one,
        ),
      );
      return true;
    });
    if (!given) return false;
    const result = await keychain.remove(item);
    if (result === "unknown") return false;
    await note(home, item, null);
    return true;
  }

  /** In words, for the command line. */
  where(): string {
    switch (this.source) {
      case "environment":
        return "From KONFAB_GITHUB_TOKEN.";
      case "stored":
        return `Stored ${keptIn(this.deps.keychain.kept)}.`;
      case "earlier":
        return "Stored in your Keychain by an earlier version (konfab-github-token).";
      default:
        return "None: the skill search works without one, with fewer searches an hour.";
    }
  }
}

export class GithubTokenError extends Error {}
