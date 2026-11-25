import { randomInt, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../settings-file.js";
import {
  readJson,
  readSettings,
  removeSettings,
  settingsPath,
  writeJson,
  writeSettings,
  readState,
  writeState,
  type NoticeState,
  type TelegramSettings,
} from "./store.js";
import { isOldItem, isOwnItem, itemOf, newItem } from "./token.js";

/**
 * Which tokens this Konfab folder has stored, without any token. Everything
 * here is in the lock that all of Konfab's writers of this folder take. See
 * docs/design/settings-phone-setup.md for who may claim and delete what.
 */
export type Note = {
  item: string;
  at: number;
  state: "storing" | "ready" | "unknown" | "unused";
  bot_id: string | null;
  /** The setup it was made for, by the code in its command. */
  code: string;
  /** The setup that took it. */
  claimed: string | null;
};

export const WANTED_MS = 15 * 60_000;
const notesPath = (home: string) => join(home, "telegram-notes.json");
const STATES = ["storing", "ready", "unknown", "unused"];
const CODE = /^[A-HJ-NP-Z2-9]{6}$/;
// Without letters and digits that look alike.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Says which setup is meant. Not a secret. */
export const newPairing = (): string =>
  Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
    "",
  );
export const isPairing = (value: unknown): value is string =>
  typeof value === "string" && CODE.test(value);

export function readNotes(home: string): Note[] {
  const value = readJson(notesPath(home)) as { notes?: unknown } | null;
  const notes = Array.isArray(value?.notes) ? (value.notes as Note[]) : [];
  return notes.filter(
    (note) =>
      typeof note === "object" &&
      note !== null &&
      (isOwnItem(note.item) || isOldItem(note.item)) &&
      Number.isFinite(note.at) &&
      STATES.includes(note.state) &&
      typeof note.code === "string" &&
      (note.bot_id === null || typeof note.bot_id === "string") &&
      (note.claimed === null || typeof note.claimed === "string"),
  );
}

function writeNotes(home: string, notes: Note[]): void {
  if (notes.length) writeJson(notesPath(home), { notes });
  else rmSync(notesPath(home), { force: true });
}

const change = (home: string, item: string, part: Partial<Note>) =>
  withLock(home, () => {
    const notes = readNotes(home);
    const note = notes.find((one) => one.item === item);
    // One that is unused stays so, whatever comes late.
    if (!note || note.state === "unused") return false;
    Object.assign(note, part);
    writeNotes(home, notes);
    return true;
  });

/** Before anything is stored. */
export const beginItem = (
  home: string,
  code: string,
  now: number,
  claimed: string | null = null,
): Promise<string> =>
  withLock(home, () => {
    const item = newItem();
    writeNotes(home, [
      ...readNotes(home),
      { item, at: now, state: "storing", bot_id: null, code, claimed },
    ]);
    return item;
  });

export const noteReady = (home: string, item: string, bot: string) =>
  change(home, item, { state: "ready", bot_id: bot });
export const noteUnknown = (home: string, item: string) =>
  change(home, item, { state: "unknown" });

/** Surely nothing is there, or it was deleted. */
export const dropNote = (home: string, item: string): Promise<void> =>
  withLock(home, () => {
    writeNotes(
      home,
      readNotes(home).filter((note) => note.item !== item),
    );
  });

/** Once, by the setup that it was made for. */
export const claim = (
  home: string,
  code: string,
  setup: string,
  now: number,
  /** Asked in the lock: waiting for it can take a while. */
  still: () => boolean = () => true,
): Promise<Note | null> =>
  withLock(home, () => {
    if (!still()) return null;
    const notes = readNotes(home);
    const note = notes.find(
      (one) =>
        one.state === "ready" &&
        one.code === code &&
        one.claimed === null &&
        now - one.at < WANTED_MS &&
        one.at <= now,
    );
    if (!note) return null;
    note.claimed = setup;
    writeNotes(home, notes);
    return { ...note };
  });

/** Its file is there but can't be read, so it isn't known what it names. */
const unclear = (home: string) =>
  existsSync(settingsPath(home)) && readSettings(home) === null;

/** What a setup leaves behind when it is replaced or removed. */
function withOld(
  notes: Note[],
  old: TelegramSettings | null,
  now: number,
): Note[] {
  const item = old && itemOf(old);
  if (!item || notes.some((note) => note.item === item))
    return notes.map((note) =>
      note.item === item ? { ...note, state: "unused", claimed: null } : note,
    );
  return [
    ...notes,
    {
      item,
      at: now,
      state: "unused",
      bot_id: old.bot_id,
      code: "",
      claimed: null,
    },
  ];
}

/**
 * The one step in which a new setup replaces the one it began with. Refused
 * when that isn't the current one any more, or its token isn't its own.
 */
export const commit = (
  home: string,
  next: TelegramSettings,
  began: string | null,
  now: number,
  /** Asked in the lock: the setup can be ended while it waits for it. */
  still: () => boolean = () => true,
  /** After each write, still in the lock. From "settings" on it is saved. */
  written: (what: "notes" | "settings") => void = () => undefined,
): Promise<{ done: boolean; old: string | null }> =>
  withLock(home, () => {
    if (!still()) return { done: false, old: null };
    const current = readSettings(home);
    if ((current?.setup_id ?? null) !== began)
      return { done: false, old: null };
    let notes = readNotes(home);
    if (next.slot === "own") {
      const note = notes.find((one) => one.item === next.item);
      if (
        note?.state !== "ready" ||
        note.claimed !== next.setup_id ||
        note.bot_id !== next.bot_id
      )
        return { done: false, old: null };
    }
    notes = withOld(notes, current, now);
    // In this order: after a crash, an item has a note or is in use.
    writeNotes(home, notes);
    written("notes");
    writeSettings(home, next);
    written("settings");
    writeNotes(
      home,
      notes.filter((note) => note.item !== next.item),
    );
    const old = current && itemOf(current);
    return { done: true, old: isOwnItem(old) ? old : null };
  });

/** On or off; what happens while it is off is never sent later. */
export const turn = (
  home: string,
  enabled: boolean,
  /** Null: as of the server's next look. */
  baseline: NoticeState["baseline"] = null,
): Promise<TelegramSettings | null> =>
  withLock(home, () => {
    const settings = readSettings(home);
    if (!settings || settings.enabled === enabled) return settings;
    const next = { ...settings, enabled };
    writeState(home, {
      ...readState(home, settings.setup_id),
      rooms: {},
      baseline: enabled ? baseline : null,
    });
    writeSettings(home, next);
    return next;
  });

/** Takes the setup away first. Its own item, which may then be deleted. */
export const removeSetup = (
  home: string,
  now: number,
): Promise<{ removed: boolean; item: string | null }> =>
  withLock(home, () => {
    const current = readSettings(home);
    if (!current) {
      // One that can't be read sends nothing; what it names isn't known.
      const there = existsSync(settingsPath(home));
      removeSettings(home);
      return { removed: there, item: null };
    }
    writeNotes(home, withOld(readNotes(home), current, now));
    removeSettings(home);
    const item = itemOf(current);
    return { removed: true, item: isOwnItem(item) ? item : null };
  });

/** Not in use, and not of a setup that is under way. */
export function leftOver(
  home: string,
  now: number,
  underWay: string | null,
): Note[] {
  const current = readSettings(home);
  const used = current && itemOf(current);
  return readNotes(home).filter(
    (note) =>
      note.item !== used &&
      (note.state === "unused" ||
        note.state === "unknown" ||
        (note.claimed !== null && note.claimed !== underWay) ||
        (note.claimed === null && now - note.at >= WANTED_MS)),
  );
}

/**
 * From here on the item can't come into use again, so it may be deleted
 * outside the lock. Null if it mustn't.
 */
export const giveUp = (
  home: string,
  item: string,
  underWay: string | null,
): Promise<string | null> =>
  withLock(home, () => {
    if (unclear(home)) return null;
    const current = readSettings(home);
    if (current && itemOf(current) === item) return null;
    const notes = readNotes(home);
    const note = notes.find((one) => one.item === item);
    if (!note || (underWay !== null && note.claimed === underWay)) return null;
    Object.assign(note, { state: "unused", claimed: null });
    writeNotes(home, notes);
    return item;
  });

export const newSetupId = (): string => randomUUID();
