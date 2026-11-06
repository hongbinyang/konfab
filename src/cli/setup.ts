import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  databasePath,
  ensureHome,
  konfabHome,
  loadConfig,
} from "../server/config.js";
import { generateToken } from "../server/domain/service.js";
import { createRuntime } from "../server/runtime.js";

const rotate = process.argv.includes("--rotate");
const home = konfabHome();
ensureHome(home);
const config = loadConfig(home);
const { db, service } = createRuntime(databasePath(home), config);

const nodePath = process.execPath;
const bridgePath = resolve(import.meta.dirname, "../bridge/index.js");
const url = `http://127.0.0.1:${config.server.port}`;

const snippetFor = (agentId: string, token: string): string => {
  const env = { KONFAB_URL: url, KONFAB_TOKEN: token };
  if (agentId === "codex") {
    return [
      "```toml",
      "[mcp_servers.konfab]",
      `command = ${JSON.stringify(nodePath)}`,
      `args = [${JSON.stringify(bridgePath)}]`,
      "tool_timeout_sec = 120",
      "",
      "[mcp_servers.konfab.env]",
      `KONFAB_URL = ${JSON.stringify(url)}`,
      `KONFAB_TOKEN = ${JSON.stringify(token)}`,
      "```",
    ].join("\n");
  }
  return [
    "```json",
    JSON.stringify(
      {
        mcpServers: { konfab: { command: nodePath, args: [bridgePath], env } },
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
};

const sections: string[] = [];
let changed = 0;
for (const agentId of Object.keys(config.agents)) {
  if (rotate || !service.agentHasToken(agentId)) {
    const token = generateToken();
    service.setAgentToken(agentId, token);
    sections.push(`## ${agentId}\n\n${snippetFor(agentId, token)}\n`);
    changed += 1;
  }
}
db.close();

if (changed === 0) {
  console.log(
    "All agents already have tokens. Run `npm run setup -- --rotate` to replace them.",
  );
} else {
  const file = join(home, "app-setup.md");
  writeFileSync(
    file,
    `# Konfab app configuration\n\nThese entries contain secret tokens. Do not commit them.\n\n${sections.join("\n")}`,
    { mode: 0o600 },
  );
  console.log(
    `Created ${changed} agent token(s). App configuration is in ${file}`,
  );
}
