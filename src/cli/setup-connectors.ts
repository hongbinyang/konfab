import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  configureClaude,
  configureCodex,
  readClaude,
  readCodex,
  removeClaudeProject,
  tokenFrom,
} from "./connector-config.js";
import {
  replaceConfig,
  restoreConfig,
  snapshot,
  type Snapshot,
} from "./safe-config-files.js";
import { hashToken } from "../server/domain/service.js";

type TokenService = {
  agentHasToken(id: string): boolean;
  authenticateAgent(token: string): string | null;
  setAgentToken(id: string, token: string): void;
};
type Database = { transaction<T>(fn: () => T): () => T };
type Write = { before: Snapshot; after: string };
type Journal = { writes: Write[]; hashes: Record<string, string> };

export function recover(
  path: string,
  service: TokenService,
  candidates: Record<string, string>,
): void {
  if (!existsSync(path)) return;
  const journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
  // A journal is local sensitive state, not trusted input to arbitrary writes.
  if (
    !Array.isArray(journal.writes) ||
    journal.writes.some(
      (w) =>
        !candidates[w.before.path] ||
        candidates[w.before.path] !== w.before.path,
    )
  )
    throw new Error(
      "Setup recovery journal references unexpected files; restore backups manually.",
    );
  const committed =
    Object.keys(journal.hashes).length > 0 &&
    Object.entries(journal.hashes).every(([id, hash]) => {
      const current = journal.writes
        .flatMap((w) => {
          try {
            const data = w.before.path.endsWith(".toml")
              ? readCodex(w.after)
              : readClaude(w.after);
            return [
              tokenFrom(
                data,
                w.before.path.endsWith(".toml") ? "mcp_servers" : "mcpServers",
              ),
            ];
          } catch {
            return [];
          }
        })
        .find((token) => token && hashToken(token) === hash);
      return current !== undefined && service.authenticateAgent(current) === id;
    });
  if (!committed)
    for (const write of [...journal.writes].reverse())
      restoreConfig(write.before, write.after);
  unlinkSync(path);
}

export function installConnectors(options: {
  paths: { codex: string; claude: string; journal: string };
  service: TokenService;
  db: Database;
  bridge: string;
  node: string;
  url: string;
  tokens: Record<string, string>;
  changed: string[];
}): string[] {
  const { paths, service, db, tokens } = options;
  recover(paths.journal, service, {
    [paths.codex]: paths.codex,
    [paths.claude]: paths.claude,
  });
  const codex = snapshot(paths.codex);
  const claude = snapshot(paths.claude);
  const common = (token: string) => ({
    command: options.node,
    args: [options.bridge],
    env: { KONFAB_URL: options.url, KONFAB_TOKEN: token },
  });
  const writes: Write[] = [];
  if (tokens.codex)
    writes.push({
      before: codex,
      after: configureCodex(codex.contents ?? "", {
        ...common(tokens.codex),
        tool_timeout_sec: 120,
      }),
    });
  if (tokens.claude)
    writes.push({
      before: claude,
      after: configureClaude(claude.contents ?? "{}", common(tokens.claude)),
    });
  const changedWrites = writes.filter((w) => w.before.contents !== w.after);
  if (!changedWrites.length && !options.changed.length) return [];
  const hashes = Object.fromEntries(
    options.changed
      .filter((id) => tokens[id])
      .map((id) => [id, hashToken(tokens[id]!)]),
  );
  const journal: Journal = { writes: changedWrites, hashes };
  writeFileSync(paths.journal, JSON.stringify(journal), {
    mode: 0o600,
    flag: "wx",
  });
  const backups: string[] = [];
  try {
    db.transaction(() => {
      for (const write of changedWrites) {
        const backup = replaceConfig(write.before, write.after);
        if (backup) backups.push(backup);
      }
      for (const id of options.changed)
        if (tokens[id]) service.setAgentToken(id, tokens[id]!);
    })();
  } catch (error) {
    try {
      for (const write of [...changedWrites].reverse())
        restoreConfig(write.before, write.after);
      unlinkSync(paths.journal);
    } catch {
      /* Leave journal for recovery. */
    }
    throw error;
  }
  unlinkSync(paths.journal);
  return backups;
}

export function migrateProject(path: string): string | null {
  const file = join(path, ".mcp.json");
  const before = snapshot(file);
  if (before.contents === null)
    throw new Error(`No .mcp.json found in ${path}; nothing to migrate.`);
  const after = removeClaudeProject(before.contents);
  return after === null ? null : replaceConfig(before, after);
}
