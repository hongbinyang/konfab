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

/** Kept outside the database, so it is in no backup or export of it. */
export type TelegramSettings = {
  chat_id: number;
  chat_name: string;
  enabled: boolean;
};

/** What has been sent, without any text. Kept apart: only the server writes it. */
export type NoticeState = {
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

function read(path: string): unknown {
  try {
    if (!lstatSync(path).isFile()) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function write(path: string, value: object): void {
  const temporary = `${path}.${process.pid}.partial`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function readSettings(home: string): TelegramSettings | null {
  const value = read(settingsPath(home)) as Partial<TelegramSettings> | null;
  if (
    !value ||
    !Number.isSafeInteger(value.chat_id) ||
    // Groups and channels have negative numbers.
    (value.chat_id as number) <= 0 ||
    typeof value.chat_name !== "string"
  )
    return null;
  return {
    chat_id: value.chat_id as number,
    chat_name: value.chat_name,
    enabled: value.enabled === true,
  };
}

/** Changes when setup or the page writes the settings. */
export function settingsStamp(home: string): number {
  return statSync(settingsPath(home), { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

export function writeSettings(home: string, settings: TelegramSettings): void {
  write(settingsPath(home), settings);
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

export function readState(home: string): NoticeState {
  const value = read(statePath(home)) as NoticeState | null;
  if (
    value &&
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
  return { rooms: {}, baseline: null, day: "", day_count: 0 };
}

export function writeState(home: string, state: NoticeState): void {
  write(statePath(home), state);
}
