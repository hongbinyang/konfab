import { parse, patch } from "@decimalturn/toml-patch";

type Entry = {
  command: string;
  args: string[];
  env: Record<string, string>;
  tool_timeout_sec?: number;
};
type Map = Record<string, unknown>;

function object(value: unknown, field: string): Map {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be a table`);
  return value as Map;
}

export function readCodex(text: string): Map {
  return object(parse(text), "configuration");
}
export function readClaude(text: string): Map {
  return object(JSON.parse(text), "configuration");
}
export function tokenFrom(config: Map, table: string): string | undefined {
  const servers = object(config[table], table);
  const entry = object(servers.konfab, `${table}.konfab`);
  const env = object(entry.env, "konfab.env");
  return typeof env.KONFAB_TOKEN === "string" ? env.KONFAB_TOKEN : undefined;
}
export function configureCodex(text: string, entry: Entry): string {
  const config = readCodex(text);
  const servers = object(config.mcp_servers, "mcp_servers");
  // Keep the user's (or Konfab's opt-in) tool approvals when the entry is rewritten.
  const previous = object(servers.konfab, "mcp_servers.konfab");
  const kept: Map = {};
  for (const key of ["tools", "default_tools_approval_mode"])
    if (previous[key] !== undefined) kept[key] = previous[key];
  config.mcp_servers = { ...servers, konfab: { ...entry, ...kept } };
  return patch(text, config);
}

/** The approval mode Codex applies to Konfab's post_message, if one is set. */
export function codexPostApproval(text: string): string | undefined {
  const servers = object(readCodex(text).mcp_servers, "mcp_servers");
  const konfab = object(servers.konfab, "mcp_servers.konfab");
  const tools = object(konfab.tools, "mcp_servers.konfab.tools");
  const post = object(
    tools.post_message,
    "mcp_servers.konfab.tools.post_message",
  );
  return typeof post.approval_mode === "string"
    ? post.approval_mode
    : undefined;
}

/** Sets (or, with undefined, removes) the approval mode for Konfab's post_message only. */
export function setCodexPostApproval(
  text: string,
  mode: string | undefined,
): string {
  const config = readCodex(text);
  const servers = object(config.mcp_servers, "mcp_servers");
  const konfab = { ...object(servers.konfab, "mcp_servers.konfab") };
  const tools = { ...object(konfab.tools, "mcp_servers.konfab.tools") };
  const post = {
    ...object(tools.post_message, "mcp_servers.konfab.tools.post_message"),
  };
  if (mode === undefined) delete post.approval_mode;
  else post.approval_mode = mode;
  if (Object.keys(post).length) tools.post_message = post;
  else delete tools.post_message;
  if (Object.keys(tools).length) konfab.tools = tools;
  else delete konfab.tools;
  config.mcp_servers = { ...servers, konfab };
  return patch(text, config);
}
export function configureClaude(text: string, entry: Entry): string {
  const config = readClaude(text);
  const servers = object(config.mcpServers, "mcpServers");
  config.mcpServers = { ...servers, konfab: entry };
  return `${JSON.stringify(config, null, 2)}\n`;
}
export function removeClaudeProject(text: string): string | null {
  const config = readClaude(text);
  const servers = object(config.mcpServers, "mcpServers");
  if (!Object.hasOwn(servers, "konfab")) return null;
  const updated = { ...servers };
  delete updated.konfab;
  config.mcpServers = updated;
  return `${JSON.stringify(config, null, 2)}\n`;
}
