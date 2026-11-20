import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  statSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { codexPostApproval, setCodexPostApproval } from "./connector-config.js";
import { replaceConfig, snapshot } from "./safe-config-files.js";

/**
 * The optional "allow room posts" setting: Codex's own per-tool approval for
 * Konfab's post_message only (`[mcp_servers.konfab.tools.post_message]
 * approval_mode = "approve"`). Changed only when the lead opts in. Konfab
 * counts the value as its own only while the whole config file is still byte
 * for byte what Konfab wrote; otherwise ownership is ambiguous and Konfab
 * leaves the value alone and says so. Other approvals, the app's reviewer and
 * Konfab permission requests are unaffected.
 *
 * Claude Code isn't changed: its equivalent rule hasn't been verified yet.
 */

const APPROVE = "approve";

interface Journal {
  /** "pending" between recording the intent and finishing the config write. */
  state: "pending" | "applied";
  path: string;
  /** SHA-256 of the config file before and right after Konfab's write. */
  before_hash: string;
  after_hash: string;
  /** Modification time right after Konfab's write; a later write changes it. */
  after_mtime_ms?: number;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Konfab treats the value as its own only if the file is byte for byte, and
 * write for write (modification time), what it wrote. A conservative change
 * detector, not proof of authorship.
 */
function owned(
  codexPath: string,
  text: string,
  journal: Journal | null,
  mtimeMs = statSync(codexPath).mtimeMs,
): boolean {
  return (
    journal?.path === codexPath &&
    journal.state === "applied" &&
    journal.after_mtime_ms !== undefined &&
    sha(text) === journal.after_hash &&
    mtimeMs === journal.after_mtime_ms
  );
}

/** Test seam: runs between the ownership check and the guarded write. */
export const roomPostsHooks: { beforeWrite?: () => void } = {};

/** True when the current value is unchanged since Konfab set it. */
export function ownsRoomPosts(codexPath: string, statePath: string): boolean {
  return roomPostsStatus(codexPath, statePath).kind === "allowed_by_konfab";
}

/**
 * Konfab's own setup rewrote the connector entry (which keeps the tools
 * table). Ownership carries forward only when that guarded write started from
 * exactly the file Konfab owned and the file is still exactly what it wrote;
 * otherwise someone else's edit may be in it, and it stays ambiguous.
 */
export function keepOwnershipAfterSetup(
  codexPath: string,
  statePath: string,
  ownedText: string,
  write: { before: string | null; after: string } | undefined,
): void {
  const journal = readJournal(statePath);
  if (!journal || journal.path !== codexPath || !write) return;
  if (write.before !== ownedText || sha(ownedText) !== journal.after_hash)
    return;
  const before = snapshot(codexPath);
  const mtimeMs = statSync(codexPath).mtimeMs;
  if (
    before.contents !== write.after ||
    codexPostApproval(write.after) !== APPROVE
  )
    return;
  writeJournal(statePath, {
    ...journal,
    state: "applied",
    after_hash: sha(write.after),
    after_mtime_ms: mtimeMs,
  });
}

function readJournal(statePath: string): Journal | null {
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8")) as {
      codex_post_message?: Journal;
    };
    const journal = value.codex_post_message;
    return journal?.before_hash && journal.after_hash ? journal : null;
  } catch {
    return null;
  }
}

interface StateFile {
  codex_post_message?: Journal;
  /** The lead chose to be asked: setup no longer turns the setting on by default. */
  room_posts_declined?: boolean;
}

function readState(statePath: string): StateFile {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as StateFile;
  } catch {
    return {};
  }
}

function writeState(statePath: string, state: StateFile): void {
  if (!state.codex_post_message && !state.room_posts_declined) {
    rmSync(statePath, { force: true });
    return;
  }
  const temporary = `${statePath}.partial`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, statePath);
}

function writeJournal(statePath: string, journal: Journal | null): void {
  const state = readState(statePath);
  if (journal) state.codex_post_message = journal;
  else delete state.codex_post_message;
  writeState(statePath, state);
}

/** Whether the lead chose to keep Codex asking before room posts. */
export function roomPostsDeclined(statePath: string): boolean {
  return readState(statePath).room_posts_declined === true;
}

/** Remembers the lead's choice, so setup's default doesn't turn it back on. */
export function setRoomPostsDeclined(
  statePath: string,
  declined: boolean,
): void {
  const state = readState(statePath);
  if (declined) state.room_posts_declined = true;
  else delete state.room_posts_declined;
  writeState(statePath, state);
}

export type RoomPostsStatus =
  | { kind: "no_codex" }
  | { kind: "allowed_by_konfab" }
  | { kind: "allowed_elsewhere" }
  | { kind: "custom"; value: string }
  | { kind: "ask" };

/**
 * What Codex currently does for Konfab's post_message. "allowed_by_konfab"
 * only when the file is exactly what Konfab wrote; any later change to the
 * file makes ownership unprovable, so the value counts as set elsewhere.
 */
export function roomPostsStatus(
  codexPath: string,
  statePath: string,
): RoomPostsStatus {
  if (!existsSync(codexPath)) return { kind: "no_codex" };
  const text = readFileSync(codexPath, "utf8");
  const value = codexPostApproval(text);
  const journal = readJournal(statePath);
  if (value === APPROVE)
    return owned(codexPath, text, journal)
      ? { kind: "allowed_by_konfab" }
      : { kind: "allowed_elsewhere" };
  if (value !== undefined) return { kind: "custom", value };
  return { kind: "ask" };
}

export function describeRoomPosts(status: RoomPostsStatus): string {
  switch (status.kind) {
    case "no_codex":
      return "Codex isn't set up here, so nothing to change.";
    case "allowed_by_konfab":
      return "Codex posts in Konfab rooms without asking each time (you turned this on in Konfab setup).";
    case "allowed_elsewhere":
      return "Codex posts in Konfab rooms without asking each time (not provably set by Konfab setup).";
    case "custom":
      return `Codex has its own setting for Konfab's post_message (approval_mode = "${status.value}"); Konfab leaves it as it is.`;
    case "ask":
      return "Codex follows its normal approvals for Konfab's post_message.";
  }
}

const AMBIGUOUS = (codexPath: string) =>
  `Konfab can't tell that this value is still the one it set: ${codexPath} has changed since Konfab wrote it. Konfab leaves it as it is. To turn it off yourself, remove the [mcp_servers.konfab.tools.post_message] table (or its approval_mode) from that file.`;

/**
 * Turns the setting on. A value the user already chose is kept. An
 * interrupted earlier run is finished only if the file is still exactly as it
 * was before (the write never happened) or exactly as Konfab would write it.
 */
export function allowRoomPosts(codexPath: string, statePath: string): string {
  if (!existsSync(codexPath)) return describeRoomPosts({ kind: "no_codex" });
  const journal = readJournal(statePath);
  const text = readFileSync(codexPath, "utf8");
  if (journal?.path === codexPath && journal.state === "pending") {
    if (sha(text) !== journal.before_hash) {
      // The file changed after the intent was recorded. Even if it now holds
      // exactly what Konfab meant to write, the user could have written it,
      // so whatever is there isn't provably Konfab's.
      // The file changed in between: whatever is there now isn't provably Konfab's.
      writeJournal(statePath, null);
      const status = roomPostsStatus(codexPath, statePath);
      return status.kind === "ask"
        ? allowRoomPosts(codexPath, statePath)
        : `${describeRoomPosts(status)} An earlier Konfab setup was interrupted and the file has changed since, so Konfab didn't touch it.`;
    }
    // Still as before: the write never happened; do it now.
  }
  const status = roomPostsStatus(codexPath, statePath);
  if (status.kind !== "ask") return describeRoomPosts(status);
  const updated = setCodexPostApproval(text, APPROVE);
  // Journal first, so a crash before or after the write can be told apart next time.
  const entry: Journal = {
    state: "pending",
    path: codexPath,
    before_hash: sha(text),
    after_hash: sha(updated),
  };
  writeJournal(statePath, entry);
  const before = snapshot(codexPath);
  if (before.contents !== text) {
    writeJournal(statePath, null);
    return `${codexPath} changed while Konfab was reading it; nothing was changed. Run setup again.`;
  }
  const backup = replaceConfig(before, updated);
  writeJournal(statePath, {
    ...entry,
    state: "applied",
    after_mtime_ms: statSync(codexPath).mtimeMs,
  });
  return `Codex will post in Konfab rooms without asking each time. Only Konfab's post_message is affected; other approvals and Codex's own review of other actions are unchanged.${backup ? ` Backup: ${backup}` : ""}`;
}

/**
 * Turns the setting off, only when the file is still exactly what Konfab
 * wrote. Otherwise the value is left alone and the conflict explained.
 */
export function askBeforeRoomPosts(
  codexPath: string,
  statePath: string,
): string {
  const journal = readJournal(statePath);
  const before = snapshot(codexPath);
  if (before.contents === null) return describeRoomPosts({ kind: "no_codex" });
  // Check ownership on this exact snapshot and write from it, so an edit made
  // after the check makes the guarded replace fail instead of being removed.
  const mtimeMs = statSync(codexPath).mtimeMs;
  const value = codexPostApproval(before.contents);
  if (
    value === APPROVE &&
    owned(codexPath, before.contents, journal, mtimeMs)
  ) {
    roomPostsHooks.beforeWrite?.();
    let backup: string | null;
    try {
      backup = replaceConfig(
        before,
        setCodexPostApproval(before.contents, undefined),
      );
    } catch {
      writeJournal(statePath, null);
      return AMBIGUOUS(codexPath);
    }
    writeJournal(statePath, null);
    return `Codex will ask again before posting in Konfab rooms.${backup ? ` Backup: ${backup}` : ""}`;
  }
  const status: RoomPostsStatus =
    value === APPROVE
      ? { kind: "allowed_elsewhere" }
      : value !== undefined
        ? { kind: "custom", value }
        : { kind: "ask" };
  if (journal?.path === codexPath) {
    writeJournal(statePath, null);
    if (status.kind === "allowed_elsewhere") return AMBIGUOUS(codexPath);
  }
  if (status.kind === "allowed_elsewhere")
    return `${describeRoomPosts(status)} Konfab leaves it; remove [mcp_servers.konfab.tools.post_message] from ${codexPath} to change it.`;
  return describeRoomPosts(status);
}
