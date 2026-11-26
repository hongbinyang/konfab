import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readClaude,
  readCodex,
  setCodexPostApproval,
  tokenFrom,
} from "../../src/cli/connector-config.js";
import { parseConfig } from "../../src/server/config.js";
import {
  connectorPaths,
  Connectors,
  type Context,
} from "../../src/server/connectors/manage.js";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";

describe("connectors in the page", () => {
  let root: string;
  let home: string;
  let db: Db;
  let service: KonfabService;
  let context: Context;
  let connectors: Connectors;
  let manual: boolean;
  const facts = {
    url: "http://127.0.0.1:8787",
    node: "/usr/bin/node",
    bridge: "/k/bridge.js",
  };
  const codexFile = () => join(root, "codex", "config.toml");
  const claudeFile = () => join(root, "claude", ".claude.json");
  const tokenIn = (id: "codex" | "claude") =>
    id === "codex"
      ? tokenFrom(readCodex(readFileSync(codexFile(), "utf8")), "mcp_servers")
      : tokenFrom(readClaude(readFileSync(claudeFile(), "utf8")), "mcpServers");
  const state = (id: "codex" | "claude") =>
    connectors.view().apps.find((app) => app.id === id)!;
  const run = async (operation: Parameters<Connectors["preview"]>[0]) =>
    connectors.apply(connectors.preview(operation).id);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "konfab-connectors-"));
    home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, "codex"));
    mkdirSync(join(root, "claude"));
    writeFileSync(codexFile(), '# mine\nmodel = "x"\n');
    writeFileSync(claudeFile(), '{"theme": "dark"}\n');
    db = openDatabase(":memory:");
    service = new KonfabService(db, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60_000,
      maxMessageChars: 1000,
    });
    service.ensureAgent("codex", "Codex");
    service.ensureAgent("claude", "Claude");
    manual = false;
    context = {
      home,
      paths: connectorPaths(home, {
        CODEX_HOME: join(root, "codex"),
        CLAUDE_CONFIG_DIR: join(root, "claude"),
      }),
      facts: { ...facts },
      service,
      db,
      config: () =>
        parseConfig(manual ? "connectors:\n  install: manual\n" : ""),
    };
    connectors = new Connectors(context);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("says each app's state, without writing anything", async () => {
    const before = readFileSync(codexFile(), "utf8");
    expect(state("codex")).toMatchObject({
      state: "not_set_up",
      in_config: true,
    });
    const preview = connectors.preview({ kind: "setup", app: "codex" });
    expect(preview.files).toEqual([
      {
        path: codexFile(),
        lines: ["adds Konfab's entry", "puts in a new token"],
      },
    ]);
    expect(readFileSync(codexFile(), "utf8")).toBe(before);
    expect(service.agentHasToken("codex")).toBe(false);
    await connectors.apply(preview.id);
    expect(state("codex").state).toBe("connected");
    expect(readFileSync(codexFile(), "utf8")).toContain("# mine");
    context.facts.url = "http://127.0.0.1:9000";
    expect(state("codex").state).toBe("other_address");
    rmSync(join(root, "claude"), { recursive: true });
    expect(state("claude").state).toBe("app_not_found");
    manual = true;
    expect(state("codex").state).toBe("manual");
    expect(() => connectors.preview({ kind: "setup", app: "codex" })).toThrow(
      /manual/,
    );
  });

  it("knows a token that isn't this Konfab's, and repairs it with a new one", async () => {
    writeFileSync(
      claudeFile(),
      JSON.stringify({
        mcpServers: {
          konfab: {
            command: facts.node,
            args: [facts.bridge],
            env: { KONFAB_URL: facts.url, KONFAB_TOKEN: "kfb_other" },
          },
        },
      }),
    );
    expect(state("claude").state).toBe("token_unknown");
    await run({ kind: "setup", app: "claude" });
    expect(state("claude").state).toBe("connected");
    expect(tokenIn("claude")).not.toBe("kfb_other");
  });

  it("puts in a new token, and never shows one", async () => {
    await run({ kind: "setup", app: "codex" });
    const first = tokenIn("codex")!;
    const preview = connectors.preview({ kind: "token", app: "codex" });
    expect(JSON.stringify(preview)).not.toContain("kfb_");
    expect(JSON.stringify(connectors.view())).not.toContain("kfb_");
    await connectors.apply(preview.id);
    expect(tokenIn("codex")).not.toBe(first);
    expect(service.authenticateAgent(first)).toBeNull();
    expect(state("codex").state).toBe("connected");
  });

  it.each<[string, () => void]>([
    ["the file changed", () => writeFileSync(codexFile(), "# theirs\n")],
    [
      "the file was replaced by another",
      () => {
        const text = readFileSync(codexFile(), "utf8");
        rmSync(codexFile());
        writeFileSync(codexFile(), text);
      },
    ],
    [
      "the server's address changed",
      () => (context.facts.url = "http://127.0.0.1:9000"),
    ],
    ["a token changed", () => service.setAgentToken("codex", "kfb_new")],
  ])("writes nothing when %s after the preview", async (_name, change) => {
    const preview = connectors.preview({ kind: "setup", app: "codex" });
    change();
    const now = readFileSync(codexFile(), "utf8");
    await expect(connectors.apply(preview.id)).rejects.toThrow(
      /Nothing was written/,
    );
    expect(readFileSync(codexFile(), "utf8")).toBe(now);
    expect(existsSync(context.paths.journal)).toBe(false);
  });

  it("writes nothing, and keeps the tokens, when an app writes at the last moment", async () => {
    context.between = (path) => writeFileSync(path, "# the app wrote\n");
    await expect(run({ kind: "setup", app: "codex" })).rejects.toThrow(
      /changed during setup/,
    );
    expect(readFileSync(codexFile(), "utf8")).toBe("# the app wrote\n");
    expect(service.agentHasToken("codex")).toBe(false);
    expect(existsSync(context.paths.journal)).toBe(false);
  });

  it("refuses a link, an ended preview, and a preview twice", async () => {
    const real = join(root, "real.json");
    writeFileSync(real, "{}");
    rmSync(claudeFile());
    symlinkSync(real, claudeFile());
    expect(() => connectors.preview({ kind: "setup", app: "claude" })).toThrow(
      /link/,
    );
    rmSync(claudeFile());
    const preview = connectors.preview({ kind: "setup", app: "codex" });
    await connectors.apply(preview.id);
    await expect(connectors.apply(preview.id)).rejects.toThrow(/ended/);
  });

  it("puts the earlier file back only while it is Konfab's write and would still connect", async () => {
    const original = readFileSync(codexFile(), "utf8");
    await run({ kind: "setup", app: "codex" });
    expect(state("codex").can_undo).toBe(true);
    // Before it, Codex had no entry: putting it back removes the connector.
    await run({ kind: "undo", app: "codex" });
    expect(readFileSync(codexFile(), "utf8")).toBe(original);
    expect(state("codex")).toMatchObject({
      state: "not_set_up",
      can_undo: false,
    });
    // A repair after a Node change: the earlier entry has the old path, so
    // putting it back wouldn't connect.
    await run({ kind: "setup", app: "codex" });
    context.facts.node = "/opt/node";
    await run({ kind: "setup", app: "codex" });
    expect(state("codex").can_undo).toBe(false);
    expect(state("codex").undo_note).toMatch(/wouldn't reach this Konfab/);
    // After a new token, the backup's token is stale too, and the backup's
    // contents are never said.
    await run({ kind: "token", app: "codex" });
    const view = state("codex");
    expect(view.can_undo).toBe(false);
    expect(view.undo_note).toMatch(/wouldn't reach this Konfab/);
    expect(view.undo_note).not.toContain("kfb_");
    // An edit by hand after Konfab's write: never put back over it.
    await run({ kind: "setup", app: "claude" });
    writeFileSync(claudeFile(), readFileSync(claudeFile(), "utf8") + "\n");
    expect(state("claude")).toMatchObject({ can_undo: false });
    expect(state("claude").undo_note).toMatch(/changed since/);
    expect(() => connectors.preview({ kind: "undo", app: "claude" })).toThrow(
      /changed since/,
    );
  });

  it.each(["changed", "replaced"])(
    "puts back nothing when the backup is %s after the preview",
    async (how) => {
      await run({ kind: "setup", app: "codex" });
      const written = readFileSync(codexFile(), "utf8");
      const backup = JSON.parse(readFileSync(context.paths.changes, "utf8"))[
        codexFile()
      ].backup as string;
      const preview = connectors.preview({ kind: "undo", app: "codex" });
      const text = readFileSync(backup, "utf8");
      if (how === "changed") writeFileSync(backup, `${text}# other\n`);
      else {
        rmSync(backup);
        writeFileSync(backup, text);
      }
      await expect(connectors.apply(preview.id)).rejects.toThrow(
        /Nothing was written/,
      );
      expect(readFileSync(codexFile(), "utf8")).toBe(written);
    },
  );

  it("turns Codex's posting without asking on and off, and leaves a value of its own alone", async () => {
    await run({ kind: "setup", app: "codex" });
    expect(connectors.view().posts_on).toBe(false);
    const on = connectors.preview({ kind: "posts", on: true });
    expect(on.files[0]!.lines[0]).toMatch(/without asking/);
    await connectors.apply(on.id);
    expect(connectors.view().posts_on).toBe(true);
    expect(readFileSync(codexFile(), "utf8")).toContain(
      'approval_mode = "approve"',
    );
    await run({ kind: "posts", on: false });
    expect(connectors.view().posts_on).toBe(false);
    writeFileSync(
      codexFile(),
      setCodexPostApproval(readFileSync(codexFile(), "utf8"), "prompt"),
    );
    expect(connectors.view().posts_on).toBeNull();
    expect(() => connectors.preview({ kind: "posts", on: true })).toThrow(
      /leaves it/,
    );
  });

  it("keeps file permissions private", async () => {
    chmodSync(codexFile(), 0o600);
    await run({ kind: "setup", app: "codex" });
    expect(readFileSync(context.paths.changes, "utf8")).not.toContain("kfb_");
  });
});
