import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lookAtCommand, runCommand, type RunResult } from "./codex.js";

/**
 * A command that the lead chose instead of the app's own. Nothing of it runs
 * before the lead agreed to that one file, and not after it has changed.
 */
export type Agreed = { path: string; stamp: string };
export type Look =
  | { ok: true; path: string; stamp: string; signed_by: string | null }
  | { ok: false; reason: string };

const file = (home: string) => join(home, "codex-command.json");

function read(home: string): { agreed: Agreed | null } | undefined {
  try {
    const value = JSON.parse(readFileSync(file(home), "utf8")) as {
      agreed?: Agreed | null;
    };
    const { agreed } = value;
    return {
      agreed:
        agreed &&
        typeof agreed.path === "string" &&
        typeof agreed.stamp === "string"
          ? agreed
          : null,
    };
  } catch (error) {
    // Whatever can't be read means that nothing is agreed.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? undefined
      : { agreed: null };
  }
}

export function agree(home: string, agreed: Agreed | null): void {
  const temporary = `${file(home)}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, JSON.stringify({ agreed }), {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, file(home));
}

/**
 * Whether this file was agreed to. A command that was set before there were
 * such agreements is taken as agreed, until the first start notes it.
 */
export function isAgreed(home: string, path: string, stamp: string): boolean {
  const known = read(home);
  if (!known) return true;
  return known.agreed?.path === path && known.agreed.stamp === stamp;
}

/** At a start: what was set before counts once. */
export function noteFirst(home: string, command: string | null): void {
  if (read(home)) return;
  const look = command === null ? null : lookAtCommand(command);
  agree(home, look?.ok ? { path: look.path, stamp: look.stamp } : null);
}

/** What can be seen of a file without running it. */
export async function lookAtOwn(
  command: string,
  home: string,
  run: typeof runCommand = runCommand,
): Promise<Look> {
  const look = lookAtCommand(command);
  if (!look.ok) return { ok: false, reason: look.reason };
  if (look.path === home || look.path.startsWith(`${home}/`))
    return { ok: false, reason: "it is in Konfab's own folder" };
  let signed: RunResult | null = null;
  try {
    signed = await run(
      "/usr/bin/codesign",
      ["-d", "--verbose=2", look.path],
      5_000,
      { HOME: homedir() },
    );
  } catch {
    // Not signed, as far as is known.
  }
  const by =
    signed?.complete && signed.code === 0
      ? /^Authority=(.{1,200})$/m.exec(signed.stderr + signed.stdout)?.[1]
      : undefined;
  return {
    ok: true,
    path: look.path,
    stamp: look.stamp,
    signed_by: by ?? null,
  };
}
