import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installConnectors,
  migrateProject,
} from "../../src/cli/setup-connectors.js";
import { snapshot } from "../../src/cli/safe-config-files.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "konfab-setup-test-"));
  roots.push(root);
  const paths = {
    codex: join(root, "codex", "config.toml"),
    claude: join(root, ".claude.json"),
    journal: join(root, "journal.json"),
  };
  const current: Record<string, string> = {};
  const service = {
    agentHasToken: (id: string) => !!current[id],
    authenticateAgent: (token: string) =>
      Object.keys(current).find((id) => current[id] === token) ?? null,
    setAgentToken: (id: string, token: string) => {
      current[id] = token;
    },
  };
  const db = {
    transaction:
      <T>(fn: () => T) =>
      () => {
        const old = { ...current };
        try {
          return fn();
        } catch (error) {
          for (const key of Object.keys(current)) delete current[key];
          Object.assign(current, old);
          throw error;
        }
      },
  };
  return {
    root,
    paths,
    current,
    service,
    db,
    bridge: "/example/bridge.js",
    node: "/node",
    url: "http://127.0.0.1:8787",
  };
}
describe("user connector installation", () => {
  it("installs both, preserves unrelated settings and is idempotent", () => {
    const f = fixture();
    mkdirSync(join(f.root, "codex"));
    writeFileSync(f.paths.codex, '# comment\nmodel = "test"\n');
    writeFileSync(f.paths.claude, '{"other":true}');
    const options = {
      ...f,
      tokens: { codex: "token1", claude: "token2" },
      changed: ["codex", "claude"],
    };
    const backups = installConnectors(options);
    expect(backups).toHaveLength(2);
    expect(f.current).toEqual(options.tokens);
    expect(readFileSync(f.paths.codex, "utf8")).toContain("# comment");
    expect(JSON.parse(readFileSync(f.paths.claude, "utf8"))).toMatchObject({
      other: true,
      mcpServers: { konfab: { env: { KONFAB_TOKEN: "token2" } } },
    });
    const files = readdirSync(f.root).sort();
    expect(installConnectors({ ...options, changed: [] })).toEqual([]);
    expect(readdirSync(f.root).sort()).toEqual(files);
  });
  it("fails safely on malformed existing files", () => {
    const f = fixture();
    writeFileSync(f.paths.claude, "{");
    expect(() =>
      installConnectors({
        ...f,
        tokens: { codex: "a", claude: "b" },
        changed: ["codex", "claude"],
      }),
    ).toThrow();
    expect(snapshot(f.paths.codex).contents).toBeNull();
    expect(f.current).toEqual({});
  });
  it("rejects symlinks and migrates only the named project entry", () => {
    const f = fixture();
    const target = join(f.root, "target");
    writeFileSync(target, "{}");
    symlinkSync(target, f.paths.claude);
    expect(() => snapshot(f.paths.claude)).toThrow();
    const project = join(f.root, "project");
    mkdirSync(project);
    writeFileSync(
      join(project, ".mcp.json"),
      '{"mcpServers":{"konfab":{"command":"x"},"other":{"command":"y"}}}',
    );
    expect(migrateProject(project)).toBeTruthy();
    expect(
      JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")),
    ).toEqual({ mcpServers: { other: { command: "y" } } });
    expect(migrateProject(project)).toBeNull();
  });
});
