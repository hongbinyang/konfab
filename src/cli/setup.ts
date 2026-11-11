import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  databasePath,
  ensureHome,
  konfabHome,
  loadConfig,
} from "../server/config.js";
import { generateToken } from "../server/domain/service.js";
import { createRuntime } from "../server/runtime.js";
import { readClaude, readCodex, tokenFrom } from "./connector-config.js";
import {
  installConnectors,
  migrateProject,
  recover,
} from "./setup-connectors.js";
import { snapshot } from "./safe-config-files.js";

const args = process.argv.slice(2);
const rotate = args.includes("--rotate");
const home = konfabHome();
ensureHome(home);
const config = loadConfig(home);
const { db, service } = createRuntime(databasePath(home), config);
const paths = {
  codex: join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "config.toml",
  ),
  claude: process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json"),
  journal: join(home, "connector-setup-journal.json"),
};
const bridge = resolve(import.meta.dirname, "../bridge/index.js");
const nodePath =
  (process.env.PATH ?? "")
    .split(":")
    .map((part) => join(part || ".", "node"))
    .find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate) === realpathSync(process.execPath);
      } catch {
        return false;
      }
    }) ?? process.execPath;
if (nodePath === process.execPath)
  console.warn(
    "No stable Node path found on PATH; the recorded path may change after a Node upgrade.",
  );
const url = `http://127.0.0.1:${config.server.port}`;

try {
  const migration = args.indexOf("--migrate");
  if (migration !== -1) {
    if (args.filter((arg) => arg === "--migrate").length > 1)
      throw new Error("Use one --migrate project per command.");
    const project = args[migration + 1];
    if (!project || project.startsWith("--"))
      throw new Error("Provide a project directory after --migrate.");
    const backup = migrateProject(resolve(project));
    console.log(
      backup
        ? `Migrated project connector. Backup: ${backup}`
        : "No project connector to migrate.",
    );
  } else {
    const manual =
      args.includes("--manual") || config.connectors.install === "manual";
    if (!manual)
      recover(paths.journal, service, {
        [paths.codex]: paths.codex,
        [paths.claude]: paths.claude,
      });
    const candidates: Record<string, string[]> = { codex: [], claude: [] };
    for (const id of ["claude", "codex"] as const) {
      if (manual) continue;
      const file = snapshot(paths[id]);
      if (file.contents === null) continue;
      const parsed =
        id === "codex" ? readCodex(file.contents) : readClaude(file.contents);
      const token = tokenFrom(
        parsed,
        id === "codex" ? "mcp_servers" : "mcpServers",
      );
      if (token) candidates[id]!.push(token);
    }
    const snippets = join(home, "app-setup.md");
    if (existsSync(snippets)) {
      const text = readFileSync(snippets, "utf8");
      for (const match of text.matchAll(
        /## (codex|claude)\s+```(toml|json)\s+([\s\S]*?)```/g,
      )) {
        try {
          const id = match[1]!;
          const parsed =
            id === "codex" ? readCodex(match[3]!) : readClaude(match[3]!);
          const token = tokenFrom(
            parsed,
            id === "codex" ? "mcp_servers" : "mcpServers",
          );
          if (token) candidates[id]!.push(token);
        } catch {
          /* An old snippet may be malformed. */
        }
      }
    }
    const tokens: Record<string, string> = {};
    const changed: string[] = [];
    for (const id of ["claude", "codex"] as const) {
      if (!(id in config.agents)) continue;
      const existing = candidates[id]!.find(
        (token) => service.authenticateAgent(token) === id,
      );
      if (rotate || !service.agentHasToken(id)) {
        tokens[id] = generateToken();
        changed.push(id);
      } else if (existing) tokens[id] = existing;
      else if (!manual)
        throw new Error(
          `Cannot recover the existing ${id} connector token. Restore its configuration or explicitly use --rotate.`,
        );
    }
    if (manual) {
      if (changed.length) {
        const sections = changed.map((id) => {
          const env = { KONFAB_URL: url, KONFAB_TOKEN: tokens[id] };
          return id === "codex"
            ? `## codex\n\n\`\`\`toml\n[mcp_servers.konfab]\ncommand = ${JSON.stringify(nodePath)}\nargs = [${JSON.stringify(bridge)}]\ntool_timeout_sec = 120\n\n[mcp_servers.konfab.env]\nKONFAB_URL = ${JSON.stringify(url)}\nKONFAB_TOKEN = ${JSON.stringify(tokens[id])}\n\`\`\`\n`
            : `## claude\n\n\`\`\`json\n${JSON.stringify({ mcpServers: { konfab: { command: nodePath, args: [bridge], env } } }, null, 2)}\n\`\`\`\n`;
        });
        writeFileSync(
          snippets,
          `# Konfab app configuration\n\nThese entries contain secret tokens. Do not commit them.\n\n${sections.join("\n")}`,
          { mode: 0o600 },
        );
        db.transaction(() => {
          for (const id of changed) service.setAgentToken(id, tokens[id]!);
        })();
        console.log(
          `Created ${changed.length} agent token(s). App configuration is in ${snippets}`,
        );
      } else console.log("All agents already have tokens; no changes made.");
    } else {
      const backups = installConnectors({
        paths,
        service,
        db,
        bridge,
        node: nodePath,
        url,
        tokens,
        changed,
      });
      console.log(
        "User-level connector setup complete. Reload the desktop clients to use changes.",
      );
      for (const backup of backups) console.log(`Secret backup: ${backup}`);
      console.log(
        "Existing project connector entries are unchanged; migrate a known project only after verifying the user-level connection.",
      );
    }
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Connector setup failed.",
  );
  process.exitCode = 1;
} finally {
  db.close();
}
