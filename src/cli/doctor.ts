import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { configPath, parseConfig } from "../server/config.js";
import { hashToken } from "../server/domain/service.js";
import { readClaude, readCodex, tokenFrom } from "./connector-config.js";

/**
 * Read-only checks for a Konfab install. Creates nothing, changes nothing and
 * opens the database read-only. Each problem comes with the fix to apply.
 */

export type Level = "ok" | "warn" | "fail";
export interface Finding {
  check: string;
  level: Level;
  detail: string;
  fix?: string;
}

const root = resolve(import.meta.dirname, "../..");

/** The dependency fingerprint quickstart records after a verified install. */
export function installFingerprint(projectRoot: string) {
  return {
    lockfile: createHash("sha256")
      .update(readFileSync(join(projectRoot, "package-lock.json")))
      .digest("hex"),
    abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  };
}

function installNode(): string {
  if (process.platform === "darwin")
    return "Install Node 24: `brew install node@24` (or nvm/fnm with this repo's .nvmrc, or nodejs.org).";
  if (process.platform === "linux")
    return "Install Node 24 with nvm/fnm (this repo has .nvmrc), NodeSource, or nodejs.org.";
  return "Install Node 24 from nodejs.org.";
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

export async function diagnose(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot = root,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (finding: Finding) => findings.push(finding);

  // Node and dependencies are checked by scripts/doctor.mjs when it runs this.
  if (env.KONFAB_DOCTOR_BOOTSTRAPPED !== "1") {
    const major = Number(process.versions.node.split(".")[0]);
    add(
      major === 24
        ? {
            check: "Node",
            level: "ok",
            detail: `Node ${process.versions.node}`,
          }
        : {
            check: "Node",
            level: "fail",
            detail: `Node ${process.versions.node} is running; Konfab needs Node 24.`,
            fix: installNode(),
          },
    );

    // Dependencies: the recorded fingerprint must match, and the native module must load.
    const record = join(projectRoot, "node_modules", ".konfab-install.json");
    let recorded: unknown;
    try {
      recorded = JSON.parse(readFileSync(record, "utf8"));
    } catch {
      recorded = null;
    }
    const expected = installFingerprint(projectRoot);
    const loads =
      spawnSync(
        process.execPath,
        [
          "-e",
          "const D=require('better-sqlite3');new D(':memory:').prepare('select 1').get()",
        ],
        { cwd: projectRoot, stdio: "ignore", timeout: 20_000 },
      ).status === 0;
    if (!loads)
      add({
        check: "Dependencies",
        level: "fail",
        detail: "The SQLite module doesn't load with this Node.",
        fix: "Run `npm run quickstart` to reinstall. If the install has to compile it, first install build tools: `xcode-select --install` (macOS) or `sudo apt install build-essential python3` (Linux).",
      });
    else if (JSON.stringify(recorded) !== JSON.stringify(expected))
      add({
        check: "Dependencies",
        level: "warn",
        detail:
          "Installed packages weren't recorded for this lockfile, Node version and CPU.",
        fix: "Run `npm run quickstart`; it reinstalls with `npm ci` when they differ.",
      });
    else
      add({
        check: "Dependencies",
        level: "ok",
        detail: "Installed and loading",
      });
  }

  const home = env.KONFAB_HOME ?? join(homedir(), ".konfab");
  if (!existsSync(home))
    add({
      check: "Data folder",
      level: "warn",
      detail: `${home} doesn't exist yet.`,
      fix: "It is created on the first `npm run quickstart` or `npm start`.",
    });
  else {
    try {
      accessSync(home, constants.W_OK);
      add({ check: "Data folder", level: "ok", detail: home });
    } catch {
      add({
        check: "Data folder",
        level: "fail",
        detail: `${home} isn't writable.`,
        fix: `Make it yours and writable: \`chmod u+rwx "${home}"\` (check its owner with \`ls -ld "${home}"\`).`,
      });
    }
  }

  let port = 8787;
  const config = configPath(home);
  if (existsSync(config)) {
    try {
      port = parseConfig(readFileSync(config, "utf8")).server.port;
      add({ check: "Config", level: "ok", detail: config });
    } catch (error) {
      add({
        check: "Config",
        level: "fail",
        detail: `${config} isn't valid: ${(error as Error).message.split("\n").slice(0, 6).join(" ")}`,
        fix: `Fix the line named above. To start from defaults but keep your edits, move it aside (\`mv "${config}" "${config}.bak"\`); the default file is written on the next start and you can copy settings back. Rooms and skills are in konfab.db and aren't affected.`,
      });
    }
  } else
    add({
      check: "Config",
      level: "ok",
      detail:
        "No config.yaml yet; defaults apply and the file is written on first start.",
    });

  add(
    (await portFree(port))
      ? { check: "Port", level: "ok", detail: `127.0.0.1:${port} is free` }
      : {
          check: "Port",
          level: "warn",
          detail: `127.0.0.1:${port} is in use (Konfab may already be running).`,
          fix: `See what uses it: \`${process.platform === "linux" ? `ss -ltnp 'sport = :${port}'` : `lsof -nP -iTCP:${port} -sTCP:LISTEN`}\`. To use another port, set \`server.port\` in ${config}.`,
        },
  );

  // Connectors: present, pointing at this checkout and a Node that exists, with a token the database accepts.
  const database = join(home, "konfab.db");
  let db: Database.Database | null = null;
  try {
    if (existsSync(database))
      db = new Database(database, { readonly: true, fileMustExist: true });
  } catch {
    db = null;
  }
  const apps = [
    {
      id: "codex",
      name: "Codex",
      file: join(env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"),
      table: "mcp_servers",
      read: readCodex,
    },
    {
      id: "claude",
      name: "Claude Code",
      file: env.CLAUDE_CONFIG_DIR
        ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
        : join(homedir(), ".claude.json"),
      table: "mcpServers",
      read: readClaude,
    },
  ];
  for (const app of apps) {
    const check = `Connector: ${app.name}`;
    if (!existsSync(app.file)) {
      add({
        check,
        level: "warn",
        detail: `${app.file} doesn't exist (${app.name} not installed, or not started yet).`,
        fix: `Start ${app.name} once, then run \`npm run setup\`. Or use \`npm run setup -- --manual\` and add the entry by hand.`,
      });
      continue;
    }
    try {
      const parsed = app.read(readFileSync(app.file, "utf8"));
      const servers = (parsed[app.table] ?? {}) as Record<string, unknown>;
      const entry = servers.konfab as
        { command?: unknown; args?: unknown } | undefined;
      if (!entry) {
        add({
          check,
          level: "fail",
          detail: `No konfab entry in ${app.file}.`,
          fix: "Run `npm run setup`.",
        });
        continue;
      }
      const command = typeof entry.command === "string" ? entry.command : "";
      const bridge =
        Array.isArray(entry.args) && typeof entry.args[0] === "string"
          ? entry.args[0]
          : "";
      const token = tokenFrom(parsed, app.table);
      if (!command || !existsSync(command))
        add({
          check,
          level: "fail",
          detail: `The Node it runs (${command || "none"}) doesn't exist; Node may have been upgraded or moved.`,
          fix: "Run `npm run setup` to record the current Node.",
        });
      else if (!bridge || !existsSync(bridge))
        add({
          check,
          level: "fail",
          detail: `The bridge it runs (${bridge || "none"}) doesn't exist; this checkout may have moved.`,
          fix: "Run `npm run setup` from this checkout.",
        });
      else if (
        resolve(dirname(bridge), "../..") !== projectRoot &&
        bridge !== join(projectRoot, "dist", "bridge", "index.js")
      )
        add({
          check,
          level: "warn",
          detail: `It points at another checkout: ${bridge}.`,
          fix: "Run `npm run setup` here if this is the checkout you use.",
        });
      else if (!db)
        add({
          check,
          level: "warn",
          detail: "No database yet, so its token can't be checked.",
          fix: "Start Konfab once with `npm run quickstart`.",
        });
      else if (
        !token ||
        !db
          .prepare("SELECT 1 FROM apps WHERE token_hash = ?")
          .get(hashToken(token))
      )
        add({
          check,
          level: "fail",
          detail: "Its token isn't accepted by this Konfab.",
          fix: "Run `npm run setup`. If it can't recover the token, `npm run setup -- --rotate` issues new ones; agents in rooms then need their rejoin prompt.",
        });
      else add({ check, level: "ok", detail: app.file });
    } catch (error) {
      add({
        check,
        level: "fail",
        detail: `${app.file} can't be read: ${(error as Error).message}`,
        fix: `Fix the file, or restore it from a backup next to it (\`${app.file}.*\`).`,
      });
    }
  }
  db?.close();

  add(
    env.KONFAB_GITHUB_TOKEN
      ? {
          check: "GitHub token",
          level: "ok",
          detail: "Set in KONFAB_GITHUB_TOKEN",
        }
      : {
          check: "GitHub token",
          level: "warn",
          detail:
            "Not set in the environment (optional). Public skill search works with lower limits.",
          fix:
            process.platform === "darwin"
              ? "If you haven't stored one in the Keychain, add one with `npm run setup -- --github-token` or set KONFAB_GITHUB_TOKEN."
              : "Set KONFAB_GITHUB_TOKEN before starting Konfab.",
        },
  );
  if (process.platform !== "darwin")
    add({
      check: "Start at login",
      level: "warn",
      detail: "Not available on this platform.",
      fix: "Start Konfab with `npm start` (or your own service manager).",
    });
  return findings;
}

export function report(findings: Finding[]): string {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  return findings
    .map(
      (finding) =>
        `${mark[finding.level]}  ${finding.check}: ${finding.detail}${finding.fix ? `\n      → ${finding.fix}` : ""}`,
    )
    .join("\n");
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(import.meta.filename)
) {
  const findings = await diagnose();
  console.log(report(findings));
  if (findings.some((finding) => finding.level === "fail"))
    process.exitCode = 1;
}
