import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { codexPostApproval, setCodexPostApproval } from "./connector-config.js";
import { replaceConfig, snapshot } from "./safe-config-files.js";

/**
 * The optional "allow room posts" setting: Codex's own per-tool approval for
 * Konfab's post_message only (`[mcp_servers.konfab.tools.post_message]
 * approval_mode = "approve"`). Changed only when the lead opts in, and undone
 * only where the value is still the one Konfab set. Other approvals, the app's
 * reviewer and Konfab permission requests are unaffected.
 *
 * Claude Code isn't changed: its equivalent rule hasn't been verified yet.
 */

const APPROVE = "approve";

interface Record_ {
  /** "pending" between recording the intent and finishing the config write. */
  state: "pending" | "applied";
  path: string;
}

function readRecord(statePath: string): Record_ | null {
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8")) as {
      codex_post_message?: Record_;
    };
    return value.codex_post_message ?? null;
  } catch {
    return null;
  }
}

function writeRecord(statePath: string, record: Record_ | null): void {
  if (!record) {
    rmSync(statePath, { force: true });
    return;
  }
  const temporary = `${statePath}.partial`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ codex_post_message: record }, null, 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(temporary, statePath);
}

export type RoomPostsStatus =
  | { kind: "no_codex" }
  | { kind: "allowed_by_konfab" }
  | { kind: "allowed_elsewhere" }
  | { kind: "custom"; value: string }
  | { kind: "ask" };

/** What Codex currently does for Konfab's post_message, and whether Konfab set it. */
export function roomPostsStatus(
  codexPath: string,
  statePath: string,
): RoomPostsStatus {
  if (!existsSync(codexPath)) return { kind: "no_codex" };
  const value = codexPostApproval(readFileSync(codexPath, "utf8"));
  const record = readRecord(statePath);
  if (value === APPROVE)
    return record?.path === codexPath
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
      return "Codex posts in Konfab rooms without asking each time (set outside Konfab setup).";
    case "custom":
      return `Codex has its own setting for Konfab's post_message (approval_mode = "${status.value}"); Konfab leaves it as it is.`;
    case "ask":
      return "Codex follows its normal approvals for Konfab's post_message.";
  }
}

/**
 * Turns the setting on. A custom value the user already chose is kept; an
 * interrupted earlier run is finished. Returns what happened, in words.
 */
export function allowRoomPosts(codexPath: string, statePath: string): string {
  const record = readRecord(statePath);
  const status = roomPostsStatus(codexPath, statePath);
  if (status.kind === "no_codex") return describeRoomPosts(status);
  if (status.kind === "allowed_by_konfab") {
    if (record?.state === "pending")
      writeRecord(statePath, { state: "applied", path: codexPath });
    return describeRoomPosts(status);
  }
  if (status.kind === "allowed_elsewhere" || status.kind === "custom")
    return describeRoomPosts(status);
  // Record the intent first, so a crash before the config write is understood next time.
  writeRecord(statePath, { state: "pending", path: codexPath });
  const before = snapshot(codexPath);
  const backup = replaceConfig(
    before,
    setCodexPostApproval(before.contents ?? "", APPROVE),
  );
  writeRecord(statePath, { state: "applied", path: codexPath });
  return `Codex will post in Konfab rooms without asking each time. Only Konfab's post_message is affected; other approvals and Codex's own review of other actions are unchanged.${backup ? ` Backup: ${backup}` : ""}`;
}

/**
 * Turns the setting off, but only where the value is still the one Konfab set;
 * a value the user changed afterwards is left alone and explained.
 */
export function askBeforeRoomPosts(
  codexPath: string,
  statePath: string,
): string {
  const record = readRecord(statePath);
  const status = roomPostsStatus(codexPath, statePath);
  if (!record || record.path !== codexPath) {
    if (status.kind === "allowed_elsewhere")
      return `${describeRoomPosts(status)} Konfab didn't set it, so it leaves it; remove [mcp_servers.konfab.tools.post_message] from ${codexPath} to change it.`;
    return describeRoomPosts(status);
  }
  if (status.kind === "allowed_by_konfab") {
    const before = snapshot(codexPath);
    const backup = replaceConfig(
      before,
      setCodexPostApproval(before.contents ?? "", undefined),
    );
    writeRecord(statePath, null);
    return `Codex will ask again before posting in Konfab rooms.${backup ? ` Backup: ${backup}` : ""}`;
  }
  writeRecord(statePath, null);
  return status.kind === "custom"
    ? `Konfab's setting was changed to approval_mode = "${status.value}" after Konfab set it, so Konfab leaves your value as it is.`
    : describeRoomPosts(status);
}
