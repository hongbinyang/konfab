import { describe, expect, it } from "vitest";
import {
  configureClaude,
  configureCodex,
  readClaude,
  readCodex,
  removeClaudeProject,
  tokenFrom,
} from "../../src/cli/connector-config.js";

const entry = {
  command: "/usr/bin/node",
  args: ["/bridge.js"],
  env: { KONFAB_TOKEN: "synthetic", KONFAB_URL: "http://127.0.0.1:8787" },
};
describe("connector configuration editing", () => {
  it("preserves unrelated TOML values and comments while adding a connector", () => {
    const original =
      '# keep this comment\nmodel = "test"\n\n[mcp_servers.other]\ncommand = "other"\n';
    const result = configureCodex(original, entry);
    expect(result).toContain("# keep this comment");
    expect(readCodex(result)).toMatchObject({
      model: "test",
      mcp_servers: { other: { command: "other" }, konfab: entry },
    });
    expect(tokenFrom(readCodex(result), "mcp_servers")).toBe("synthetic");
    expect(configureCodex(result, entry)).toBe(result);
  });
  it("updates inline tables without losing sibling servers", () => {
    const original =
      'mcp_servers = { other = { command = "other" }, konfab = { command = "old" } }\n';
    expect(readCodex(configureCodex(original, entry))).toMatchObject({
      mcp_servers: { other: { command: "other" }, konfab: entry },
    });
  });
  it("preserves unrelated Claude settings and migrates only the matching server", () => {
    const original = '{"settings":true,"mcpServers":{"other":{"command":"x"}}}';
    const configured = configureClaude(original, entry);
    expect(readClaude(configured)).toMatchObject({
      settings: true,
      mcpServers: { other: { command: "x" }, konfab: entry },
    });
    expect(readClaude(removeClaudeProject(configured)!)).toEqual(
      readClaude(original),
    );
    expect(removeClaudeProject(original)).toBeNull();
  });
  it("rejects malformed and conflicting structures", () => {
    expect(() => configureCodex("[mcp_servers\n", entry)).toThrow();
    expect(() => configureCodex('mcp_servers = "bad"', entry)).toThrow();
    expect(() => configureClaude("{", entry)).toThrow();
    expect(() => configureClaude('{"mcpServers":false}', entry)).toThrow();
  });
});
