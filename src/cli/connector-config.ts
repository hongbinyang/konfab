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
  config.mcp_servers = { ...servers, konfab: entry };
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
