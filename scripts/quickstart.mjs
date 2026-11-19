#!/usr/bin/env node
/* global process, console, fetch, setTimeout */
// Get Konfab running from a fresh clone: check Node, install dependencies when
// they don't match, build, set up the app connectors, report problems, then
// start. Safe to run again. Plain Node with no dependencies, so it works before
// `npm ci`. `--check` runs the isolated end-to-end check instead of starting.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const say = (line) => console.log(line);
const stop = (line) => {
  console.error(`\n✖ ${line}`);
  process.exit(1);
};

export function fingerprint(projectRoot = root) {
  return {
    lockfile: createHash("sha256")
      .update(readFileSync(join(projectRoot, "package-lock.json")))
      .digest("hex"),
    abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  };
}

const record = join(root, "node_modules", ".konfab-install.json");

function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** True only if the recorded install matches this lockfile, Node and CPU. */
export function installMatches(projectRoot = root) {
  try {
    const recorded = readFileSync(
      join(projectRoot, "node_modules", ".konfab-install.json"),
      "utf8",
    );
    return recorded === JSON.stringify(fingerprint(projectRoot));
  } catch {
    return false;
  }
}

function nativeModuleLoads() {
  return (
    spawnSync(
      process.execPath,
      [
        "-e",
        "const D=require('better-sqlite3');new D(':memory:').prepare('select 1').get()",
      ],
      { cwd: root, stdio: "ignore", timeout: 30_000 },
    ).status === 0
  );
}

function run(command, commandArgs, failure) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) stop(failure);
}

const buildTools =
  process.platform === "darwin"
    ? "xcode-select --install"
    : process.platform === "linux"
      ? "sudo apt install build-essential python3   (or your distribution's equivalent)"
      : "the Visual Studio Build Tools";

function main() {
  // 1. Node 24.
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 24)
    stop(
      `Node ${process.versions.node} is running; Konfab needs Node 24.\n  ` +
        (process.platform === "darwin"
          ? "Install it with `brew install node@24`, or nvm/fnm (this repo has .nvmrc)."
          : "Install it with nvm/fnm (this repo has .nvmrc), NodeSource, or nodejs.org."),
    );
  say(`✓ Node ${process.versions.node}`);

  // 2. Dependencies: reinstall unless the recorded install matches and the native module loads.
  if (!installMatches() || !nativeModuleLoads()) {
    // npm ci deletes node_modules first; through a link it would empty
    // another checkout's dependencies. Never reinstall through a link.
    const modules = join(root, "node_modules");
    if (lstatSafe(modules)?.isSymbolicLink())
      stop(
        "node_modules here is a link to another folder, and reinstalling would delete that folder's packages. Replace the link with a real install (`rm node_modules && npm ci`) and run `npm run quickstart` again.",
      );
    say("… Installing dependencies (npm ci)");
    rmSync(record, { force: true });
    run(
      npm,
      ["ci"],
      `npm ci failed. If it was compiling the SQLite module, install build tools first:\n  ${buildTools}\n  then run \`npm run quickstart\` again.`,
    );
    if (!nativeModuleLoads())
      stop(
        `The SQLite module doesn't load with Node ${process.versions.node}. Install build tools (${buildTools}) and run \`npm run quickstart\` again.`,
      );
    // Recorded only after a verified install, so an interrupted one is redone.
    writeFileSync(record, JSON.stringify(fingerprint()));
  }
  say("✓ Dependencies installed and loading");

  // 3. Build.
  run(
    npm,
    ["run", "build", "--silent"],
    "The build failed; see the errors above.",
  );
  say("✓ Built");

  if (args.has("--check")) {
    run(
      process.execPath,
      [join(root, "dist/cli/check.js")],
      "The end-to-end check failed; see above.",
    );
    return;
  }

  // 4. Setup: default config and the connectors of the apps found here.
  run(
    process.execPath,
    [join(root, "dist/cli/setup.js")],
    "Setup failed; see the message above. Nothing was started.",
  );
  say("✓ Setup done");

  // 5. Doctor reports; only a failure stops.
  const doctor = spawnSync(
    process.execPath,
    [join(root, "dist/cli/doctor.js")],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if (doctor.status !== 0)
    stop("Fix the FAIL lines above, then run `npm run quickstart` again.");

  // 6. Start, then print and open the sign-in link.
  const server = spawn(process.execPath, [join(root, "dist/server/index.js")], {
    cwd: root,
    stdio: "inherit",
  });
  server.on("exit", (code) => process.exit(code ?? 0));
  const port = (() => {
    try {
      const home =
        process.env.KONFAB_HOME ??
        join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".konfab");
      const match = /^\s*port:\s*(\d+)/m.exec(
        readFileSync(join(home, "config.yaml"), "utf8"),
      );
      return match ? Number(match[1]) : 8787;
    } catch {
      return 8787;
    }
  })();
  const waitThenOpen = async () => {
    for (let i = 0; i < 100; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/login`, { redirect: "manual" });
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    const link = spawnSync(
      process.execPath,
      [join(root, "dist/cli/login-link.js")],
      {
        cwd: root,
        encoding: "utf8",
      },
    ).stdout.trim();
    say(`\nKonfab is running. Sign in: ${link}`);
    if (!args.has("--no-open") && link) {
      const opener =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer"
            : "xdg-open";
      spawn(opener, [link], { stdio: "ignore", detached: true })
        .on("error", () => undefined)
        .unref();
    }
    say(
      "Next: restart (or reload the Konfab connector in) your agent app, then paste a join prompt from the page.\n" +
        "An agent is connected when its card says “Waiting for a turn”. Press Ctrl+C to stop Konfab.",
    );
  };
  void waitThenOpen();
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
)
  main();
