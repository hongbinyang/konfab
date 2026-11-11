import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type Snapshot = { path: string; contents: string | null; mode: number };

export function snapshot(path: string): Snapshot {
  if (!existsSync(path)) return { path, contents: null, mode: 0o600 };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Refusing non-regular configuration file: ${path}`);
  return {
    path,
    contents: readFileSync(path, "utf8"),
    mode: stat.mode & 0o777,
  };
}

export function replaceConfig(
  before: Snapshot,
  contents: string,
): string | null {
  if (before.contents === contents) return null;
  const current = snapshot(before.path);
  if (current.contents !== before.contents || current.mode !== before.mode)
    throw new Error(`Configuration changed during setup: ${before.path}`);
  mkdirSync(dirname(before.path), { recursive: true, mode: 0o700 });
  let backup: string | null = null;
  if (before.contents !== null) {
    backup = `${before.path}.konfab-backup-${Date.now()}-${randomUUID()}`;
    copyFileSync(before.path, backup, 1);
    chmodSync(backup, 0o600);
  }
  const tmp = `${before.path}.konfab-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
    const again = snapshot(before.path);
    if (again.contents !== before.contents || again.mode !== before.mode)
      throw new Error(`Configuration changed during setup: ${before.path}`);
    renameSync(tmp, before.path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  return backup;
}

export function restoreConfig(before: Snapshot, expected: string): void {
  const current = snapshot(before.path);
  if (current.contents === before.contents) return;
  if (current.contents !== expected)
    throw new Error(`Cannot recover changed configuration: ${before.path}`);
  if (before.contents === null) unlinkSync(before.path);
  else {
    const tmp = `${before.path}.konfab-${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, before.contents, { mode: 0o600, flag: "wx" });
      renameSync(tmp, before.path);
      chmodSync(before.path, before.mode & 0o600);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }
}
