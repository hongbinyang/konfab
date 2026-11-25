import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isOwnItem, type TokenSlot } from "./token.js";

/** Kept outside the database, so it is in no backup or export of it. */
export type TelegramSettings = {
  chat_id: number;
  chat_name: string;
  enabled: boolean;
  /** Which stored token belongs to this setup, and the bot it must be for. */
  slot: TokenSlot;
  /** Its own item in the Keychain, for "own". */
  item?: string;
  bot_id: string;
  /** Different for every setup, so nothing of an earlier one is reused. */
  setup_id: string;
};

/** What has been sent, without any text. Kept apart: only the server writes it. */
export type NoticeState = {
  /** The setup this belongs to. */
  setup_id: string;
  rooms: Record<
    string,
    {
      message: number;
      permission: number;
      event: number;
      report: number;
      sent_at: number;
    }
  >;
  /** Things from before notices were turned on are never sent. */
  baseline: {
    message: number;
    permission: number;
    event: number;
    report: number;
  } | null;
  day: string;
  day_count: number;
};

export const settingsPath = (home: string) => join(home, "telegram.json");
export const statePath = (home: string) => join(home, "telegram-state.json");

export function readJson(path: string): unknown {
  try {
    if (!lstatSync(path).isFile()) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** All or nothing: on a failure the file is as it was. */
export function writeJson(path: string, value: object): void {
  const temporary = `${path}.${process.pid}.partial`;
  rmSync(temporary, { force: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readSettings(home: string): TelegramSettings | null {
  const value = readJson(
    settingsPath(home),
  ) as Partial<TelegramSettings> | null;
  if (
    !value ||
    !Number.isSafeInteger(value.chat_id) ||
    // Groups and channels have negative numbers.
    (value.chat_id as number) <= 0 ||
    typeof value.chat_name !== "string" ||
    !["own", "a", "b", "env"].includes(value.slot as string) ||
    (value.slot === "own") !== isOwnItem(value.item) ||
    typeof value.bot_id !== "string" ||
    !/^\d+$/.test(value.bot_id) ||
    typeof value.setup_id !== "string" ||
    !value.setup_id
  )
    return null;
  return {
    chat_id: value.chat_id as number,
    chat_name: value.chat_name,
    enabled: value.enabled === true,
    slot: value.slot as TokenSlot,
    ...(value.slot === "own" ? { item: value.item as string } : {}),
    bot_id: value.bot_id,
    setup_id: value.setup_id,
  };
}

/** Changes when setup or the page writes the settings. */
export function settingsStamp(home: string): string {
  const info = statSync(settingsPath(home), { throwIfNoEntry: false });
  // Each write makes a new file, also within one tick of the clock.
  return info ? `${info.mtimeMs}:${info.ino}` : "";
}

export function writeSettings(home: string, settings: TelegramSettings): void {
  writeJson(settingsPath(home), settings);
}

export function removeSettings(home: string): void {
  rmSync(settingsPath(home), { force: true });
  rmSync(statePath(home), { force: true });
}

const numbers = (value: unknown, keys: string[]): boolean =>
  typeof value === "object" &&
  value !== null &&
  keys.every((key) => Number.isFinite((value as Record<string, unknown>)[key]));
const MARKS = ["message", "permission", "event", "report"];

export function readState(home: string, setupId: string): NoticeState {
  const value = readJson(statePath(home)) as NoticeState | null;
  if (
    value &&
    value.setup_id === setupId &&
    typeof value.day === "string" &&
    Number.isFinite(value.day_count) &&
    typeof value.rooms === "object" &&
    value.rooms !== null &&
    Object.values(value.rooms).every((room) =>
      numbers(room, [...MARKS, "sent_at"]),
    ) &&
    (value.baseline === null || numbers(value.baseline, MARKS))
  )
    return value;
  return {
    setup_id: setupId,
    rooms: {},
    baseline: null,
    day: "",
    day_count: 0,
  };
}

export function writeState(home: string, state: NoticeState): void {
  writeJson(statePath(home), state);
}
