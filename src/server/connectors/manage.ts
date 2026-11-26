import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  codexPostApproval,
  readClaude,
  readCodex,
  setCodexPostApproval,
  tokenFrom,
} from "../../cli/connector-config.js";
import {
  allowRoomPosts,
  askBeforeRoomPosts,
  describeRoomPosts,
  roomPostsStatus,
  setRoomPostsDeclined,
} from "../../cli/room-posts.js";
import { installConnectors } from "../../cli/setup-connectors.js";
import type { Config } from "../config.js";
import { generateToken, hashToken } from "../domain/service.js";
import { withLock } from "../settings-file.js";

/**
 * The connectors of the two apps, as the page sees and changes them: a state
 * computed without writing, a preview bound to exactly what it shows, an
 * apply in the settings lock, and an undo while it is still safe. The token
 * and the contents of backups and the journal never leave this module. See
 * docs/design/settings-phase4.md.
 */
export type AppId = "codex" | "claude";
export const APPS: AppId[] = ["codex", "claude"];
const NAMES: Record<AppId, string> = { codex: "Codex", claude: "Claude Code" };

export type ConnectorPaths = {
  codex: string;
  claude: string;
  journal: string;
  roomPosts: string;
  changes: string;
};

export function connectorPaths(
  home: string,
  env: NodeJS.ProcessEnv,
): ConnectorPaths {
  return {
    codex: join(env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"),
    claude: env.CLAUDE_CONFIG_DIR
      ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
      : join(homedir(), ".claude.json"),
    journal: join(home, "connector-setup-journal.json"),
    roomPosts: join(home, "client-settings.json"),
    changes: join(home, "connector-changes.json"),
  };
}

/** What a connector entry must say to reach this server. */
export type ServerFacts = { url: string; node: string; bridge: string };

type Service = {
  agentHasToken(id: string): boolean;
  authenticateAgent(token: string): string | null;
  setAgentToken(id: string, token: string): void;
};
type Database = { transaction<T>(fn: () => T): () => T };

export type Context = {
  home: string;
  paths: ConnectorPaths;
  facts: ServerFacts;
  service: Service;
  db: Database;
  config: () => Config;
  now?: () => number;
  /** Test seam: right before each file is replaced, in the lock. */
  between?: (path: string) => void;
};

export type ConnectorState =
  | "connected"
  | "other_address"
  | "token_unknown"
  | "not_set_up"
  | "app_not_found"
  | "manual";

export type AppView = {
  id: AppId;
  name: string;
  /** In config.yaml's agents, so Konfab makes it at the start. */
  in_config: boolean;
  state: ConnectorState;
  path: string;
  can_undo: boolean;
  /** Why undo isn't offered, and the backup's path. Never its contents. */
  undo_note: string | null;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const table = (id: AppId) => (id === "codex" ? "mcp_servers" : "mcpServers");
const parse = (id: AppId, text: string) =>
  id === "codex" ? readCodex(text) : readClaude(text);

/** Konfab's entry in an app's file, if there is one that can be read. */
function entryOf(
  id: AppId,
  text: string | null,
): { command?: unknown; args?: unknown; url?: unknown; token?: string } | null {
  if (text === null) return null;
  try {
    const config = parse(id, text);
    const servers = (config[table(id)] ?? {}) as Record<string, unknown>;
    const konfab = servers.konfab as Record<string, unknown> | undefined;
    if (!konfab) return null;
    const env = (konfab.env ?? {}) as Record<string, unknown>;
    return {
      command: konfab.command,
      args: konfab.args,
      url: env.KONFAB_URL,
      token: tokenFrom(config, table(id)),
    };
  } catch {
    return null;
  }
}

const reaches = (
  entry: NonNullable<ReturnType<typeof entryOf>>,
  facts: ServerFacts,
) =>
  entry.url === facts.url &&
  entry.command === facts.node &&
  Array.isArray(entry.args) &&
  entry.args[0] === facts.bridge;

/** A file as it is: what a preview is bound to. Never its contents. */
type FileFact = {
  path: string;
  exists: boolean;
  link: boolean;
  dev: number;
  ino: number;
  mode: number;
  hash: string | null;
};

function factOf(path: string): FileFact {
  try {
    const info = lstatSync(path);
    return {
      path,
      exists: true,
      link: info.isSymbolicLink(),
      dev: info.dev,
      ino: info.ino,
      mode: info.mode & 0o777,
      hash: info.isFile() ? sha(readFileSync(path, "utf8")) : null,
    };
  } catch {
    return {
      path,
      exists: false,
      link: false,
      dev: 0,
      ino: 0,
      mode: 0,
      hash: null,
    };
  }
}
const sameFact = (one: FileFact, other: FileFact) =>
  JSON.stringify(one) === JSON.stringify(other);
const read = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8") : null;

function installed(id: AppId, paths: ConnectorPaths): boolean {
  return id === "codex"
    ? existsSync(dirname(paths.codex))
    : existsSync(paths.claude) ||
        existsSync(join(dirname(paths.claude), ".claude"));
}

/** Konfab's own record of its last write to each file. */
type Change = {
  app: AppId;
  dev: number;
  ino: number;
  hash: string;
  backup: string | null;
};
function readChanges(path: string): Record<string, Change> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, Change>)
      : {};
  } catch {
    return {};
  }
}
function writeChanges(path: string, changes: Record<string, Change>): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(changes), {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}

/** Whether undo is safe now, and if not, why. */
function undoCheck(
  id: AppId,
  context: Context,
):
  | { ok: true; contents: string | null; path: string }
  | { ok: false; note: string | null } {
  const path = context.paths[id];
  const change = readChanges(context.paths.changes)[path];
  if (!change) return { ok: false, note: null };
  const fact = factOf(path);
  if (
    !fact.exists ||
    fact.link ||
    fact.dev !== change.dev ||
    fact.ino !== change.ino ||
    fact.hash !== change.hash
  )
    return {
      ok: false,
      note: `${path} has changed since Konfab wrote it, so Konfab doesn't put the earlier one back.${change.backup ? ` The earlier file is ${change.backup}.` : ""}`,
    };
  const before = change.backup ? read(change.backup) : null;
  if (change.backup && before === null)
    return {
      ok: false,
      note: `The earlier file ${change.backup} isn't there any more.`,
    };
  const entry = entryOf(id, before);
  // Without an entry before, undo takes the connector away, which is what
  // the earlier state was.
  if (
    entry &&
    (!entry.token ||
      context.service.authenticateAgent(entry.token) !== id ||
      !reaches(entry, context.facts))
  )
    return {
      ok: false,
      note: `The earlier entry wouldn't reach this Konfab any more (its token was replaced since, or its address is another). The earlier file is ${change.backup}.`,
    };
  return { ok: true, contents: before, path };
}

export function appViews(context: Context): AppView[] {
  const config = context.config();
  const manual = config.connectors.install === "manual";
  return APPS.map((id) => {
    const path = context.paths[id];
    const entry = entryOf(id, read(path));
    const state: ConnectorState = manual
      ? "manual"
      : !installed(id, context.paths)
        ? "app_not_found"
        : !entry
          ? "not_set_up"
          : !entry.token ||
              context.service.authenticateAgent(entry.token) !== id
            ? "token_unknown"
            : reaches(entry, context.facts)
              ? "connected"
              : "other_address";
    const undo = undoCheck(id, context);
    return {
      id,
      name: NAMES[id],
      in_config: id in config.agents,
      state,
      path,
      can_undo: undo.ok,
      undo_note: undo.ok ? null : undo.note,
    };
  });
}

export type Operation =
  | { kind: "setup"; app: AppId }
  | { kind: "token"; app: AppId }
  | { kind: "posts"; on: boolean }
  | { kind: "undo"; app: AppId };

/** What the page shows. Never a token or a file's contents. */
export type PreviewView = {
  id: string;
  files: { path: string; lines: string[] }[];
  notes: string[];
};

type Preview = {
  view: PreviewView;
  operation: Operation;
  facts: ServerFacts;
  files: FileFact[];
  tokenHashes: Record<string, string | null>;
  /** Server-side only. */
  tokens: Record<string, string>;
  changed: string[];
  undo: string | null;
  at: number;
};

export class ConnectorError extends Error {}

const PREVIEW_MS = 10 * 60_000;

export class Connectors {
  private previews = new Map<string, Preview>();

  constructor(private readonly context: Context) {}

  private now(): number {
    return (this.context.now ?? Date.now)();
  }

  view(): { apps: AppView[]; posts: string; posts_on: boolean | null } {
    const status = roomPostsStatus(
      this.context.paths.codex,
      this.context.paths.roomPosts,
    );
    return {
      apps: appViews(this.context),
      posts: describeRoomPosts(status),
      // Null: Konfab leaves it as it is, so there is no switch.
      posts_on:
        status.kind === "allowed_by_konfab"
          ? true
          : status.kind === "ask"
            ? false
            : null,
    };
  }

  private tokenHashes(): Record<string, string | null> {
    return Object.fromEntries(
      APPS.map((id) => {
        const entry = entryOf(id, read(this.context.paths[id]));
        // The file's token, and whether this Konfab accepts it now.
        return [
          id,
          entry?.token
            ? `${hashToken(entry.token)}:${this.context.service.authenticateAgent(entry.token) === id}`
            : `none:${this.context.service.agentHasToken(id)}`,
        ];
      }),
    );
  }

  preview(operation: Operation): PreviewView {
    const { paths, facts, service } = this.context;
    if (
      this.context.config().connectors.install === "manual" &&
      operation.kind !== "posts"
    )
      throw new ConnectorError(
        "Setup is set to manual (connectors.install); run `npm run setup` to write the entries to app-setup.md.",
      );
    const files: FileFact[] = [];
    const lines: { path: string; lines: string[] }[] = [];
    const notes: string[] = [];
    const tokens: Record<string, string> = {};
    const changed: string[] = [];
    let undo: string | null = null;
    const touch = (path: string, said: string[]) => {
      const fact = factOf(path);
      if (fact.link)
        throw new ConnectorError(
          `${path} is a link; Konfab doesn't write through it. Change it by hand.`,
        );
      files.push(fact);
      lines.push({ path, lines: said });
    };
    if (operation.kind === "setup" || operation.kind === "token") {
      const id = operation.app;
      if (!installed(id, paths))
        throw new ConnectorError(
          `${NAMES[id]} isn't found here. Start it once, then set it up.`,
        );
      const path = paths[id];
      const entry = entryOf(id, read(path));
      const known =
        entry?.token && service.authenticateAgent(entry.token) === id
          ? entry.token
          : undefined;
      if (operation.kind === "token" || !known) {
        tokens[id] = generateToken();
        changed.push(id);
      } else tokens[id] = known;
      const said: string[] = [];
      if (!entry) said.push("adds Konfab's entry");
      else {
        if (entry.url !== facts.url)
          said.push(
            `changes the address from ${String(entry.url)} to ${facts.url}`,
          );
        if (
          entry.command !== facts.node ||
          !Array.isArray(entry.args) ||
          entry.args[0] !== facts.bridge
        )
          said.push("changes the Node and connector paths to this Konfab's");
      }
      if (changed.includes(id))
        said.push(
          known
            ? "puts in a new token; the old one stops working"
            : "puts in a new token",
        );
      if (!said.length) said.push("nothing changes");
      touch(path, said);
      notes.push(`Restart ${NAMES[id]} afterwards to use it.`);
      if (id === "claude")
        notes.push(
          "Best done while Claude Code is closed: it writes this file often.",
        );
      if (!known && service.agentHasToken(id))
        notes.push(`${NAMES[id]}'s present token stops working.`);
    } else if (operation.kind === "posts") {
      const status = roomPostsStatus(paths.codex, paths.roomPosts);
      if (
        status.kind === "no_codex" ||
        status.kind === "custom" ||
        status.kind === "allowed_elsewhere"
      )
        throw new ConnectorError(describeRoomPosts(status));
      const text = read(paths.codex)!;
      if ((codexPostApproval(text) === "approve") === operation.on)
        throw new ConnectorError("It is so already.");
      touch(paths.codex, [
        operation.on
          ? "lets Codex post in rooms without asking you each time"
          : "makes Codex ask you again before each post",
      ]);
      // Computed now only to know it can be written; applied by the same code
      // as `npm run setup`.
      setCodexPostApproval(text, operation.on ? "approve" : undefined);
      notes.push("Restart Codex afterwards to use it.");
    } else {
      const id = operation.app;
      const check = undoCheck(id, this.context);
      if (!check.ok)
        throw new ConnectorError(check.note ?? "There is nothing to undo.");
      undo = check.path;
      touch(check.path, [
        check.contents === null
          ? "removes the file Konfab made"
          : "puts back the file as it was before Konfab's last change",
      ]);
      notes.push(`Restart ${NAMES[id]} afterwards.`);
    }
    const view: PreviewView = { id: randomUUID(), files: lines, notes };
    this.previews.set(view.id, {
      view,
      operation,
      facts: { ...facts },
      files,
      tokenHashes: this.tokenHashes(),
      tokens,
      changed,
      undo,
      at: this.now(),
    });
    for (const [id, old] of this.previews)
      if (this.now() - old.at > PREVIEW_MS) this.previews.delete(id);
    return view;
  }

  /**
   * The previewed change, and nothing else: in the settings lock, after
   * checking everything it is bound to. Says what happened, file by file.
   */
  async apply(id: string): Promise<string[]> {
    const preview = this.previews.get(id);
    this.previews.delete(id);
    if (!preview || this.now() - preview.at > PREVIEW_MS)
      throw new ConnectorError("This preview has ended; look again.");
    const { context } = this;
    return withLock(context.home, () => {
      const stale =
        JSON.stringify(preview.facts) !== JSON.stringify(context.facts) ||
        preview.files.some((fact) => !sameFact(fact, factOf(fact.path))) ||
        JSON.stringify(preview.tokenHashes) !==
          JSON.stringify(this.tokenHashes());
      if (stale)
        throw new ConnectorError(
          "Something changed since the preview. Nothing was written; look again.",
        );
      const op = preview.operation;
      if (op.kind === "posts") {
        context.between?.(context.paths.codex);
        setRoomPostsDeclined(context.paths.roomPosts, !op.on);
        return [
          op.on
            ? allowRoomPosts(context.paths.codex, context.paths.roomPosts)
            : askBeforeRoomPosts(context.paths.codex, context.paths.roomPosts),
        ];
      }
      if (op.kind === "undo") return [this.putBack(op.app, preview.undo!)];
      const app = op.app;
      const writes: { path: string; after: string }[] = [];
      const backups = installConnectors({
        paths: {
          codex: context.paths.codex,
          claude: context.paths.claude,
          journal: context.paths.journal,
        },
        service: context.service,
        db: context.db,
        bridge: context.facts.bridge,
        node: context.facts.node,
        url: context.facts.url,
        tokens: { [app]: preview.tokens[app]! },
        changed: preview.changed,
        onWrite: (path, _before, after) => writes.push({ path, after }),
        between: context.between,
      });
      const changes = readChanges(context.paths.changes);
      writes.forEach(({ path, after }, index) => {
        const fact = factOf(path);
        changes[path] = {
          app,
          dev: fact.dev,
          ino: fact.ino,
          hash: sha(after),
          backup: backups[index] ?? null,
        };
      });
      writeChanges(context.paths.changes, changes);
      return writes.length
        ? [`${NAMES[app]}: written. Restart ${NAMES[app]} to use it.`]
        : [`${NAMES[app]}: nothing needed changing.`];
    });
  }

  /** In the lock: the backup back, only while the file is Konfab's write. */
  private putBack(app: AppId, path: string): string {
    const check = undoCheck(app, this.context);
    if (!check.ok)
      throw new ConnectorError(check.note ?? "There is nothing to undo.");
    this.context.between?.(path);
    const changes = readChanges(this.context.paths.changes);
    const change = changes[path]!;
    const now = factOf(path);
    if (now.hash !== change.hash)
      throw new ConnectorError(
        `${path} changed meanwhile. Nothing was put back.`,
      );
    if (check.contents === null) rmSync(path);
    else {
      const temporary = `${path}.konfab-${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, check.contents, {
          mode: now.mode || 0o600,
          flag: "wx",
        });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    delete changes[path];
    writeChanges(this.context.paths.changes, changes);
    return `${NAMES[app]}: put back. Restart ${NAMES[app]}.`;
  }
}
