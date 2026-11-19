#!/usr/bin/env node
/* global process, console, fetch, setTimeout, URL */
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
import { createServer } from "node:net";
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

async function main() {
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

  // 6. Start (or find Konfab already running), then print and open the sign-in link.
  let started;
  try {
    started = await startKonfab({ open: !args.has("--no-open") });
  } catch (error) {
    stop(error.message);
  }
  if (started.status === "already-running")
    say(
      `\nKonfab is already running from this install. Sign in: ${started.link}`,
    );
  else {
    say(`\nKonfab is running. Sign in: ${started.link}`);
    started.child.on("exit", (code) => process.exit(code ?? 0));
  }
  say(
    "Next: restart (or reload the Konfab connector in) your agent app, then paste a join prompt from the page.\n" +
      "An agent is connected when its card says “Waiting for a turn”." +
      (started.status === "started" ? " Press Ctrl+C to stop Konfab." : ""),
  );
}

/**
 * Starts the server unless this install's Konfab already answers on its port,
 * and returns a fresh sign-in link only once the server proves it is this
 * install's (a sign-in code from this database is accepted). Another program
 * on the port, a server that stops or never answers, and a failed sign-in
 * link are errors with the next step to take.
 */
export async function startKonfab({
  projectRoot = root,
  env = process.env,
  serverScript = join(projectRoot, "dist/server/index.js"),
  loginScript = join(projectRoot, "dist/cli/login-link.js"),
  open = true,
  timeoutMs = 15_000,
  stdio = "inherit",
} = {}) {
  const loginLink = () => {
    const result = spawnSync(process.execPath, [loginScript], {
      cwd: projectRoot,
      env,
      encoding: "utf8",
    });
    const link = (result.stdout ?? "").trim();
    if (
      result.status !== 0 ||
      !/^http:\/\/127\.0\.0\.1:\d+\/login\?code=/.test(link)
    )
      throw new Error(
        `Couldn't create a sign-in link: ${(result.stderr || result.stdout || "no output").trim()}\n  Run \`npm run doctor\` for details.`,
      );
    return link;
  };
  /** true: this install's Konfab; false: something else; null: nothing listening. */
  const answersAsOurs = async () => {
    try {
      const response = await fetch(loginLink(), { redirect: "manual" });
      return (
        response.status === 303 &&
        (response.headers.get("set-cookie") ?? "").startsWith("konfab_session=")
      );
    } catch (error) {
      if (error.message?.startsWith("Couldn't create")) throw error;
      return null;
    }
  };
  const port = Number(new URL(loginLink()).port);
  if (!(await portFree(port))) {
    const ours = await answersAsOurs();
    if (ours) return { status: "already-running", link: loginLink() };
    throw new Error(
      `Port ${port} is in use by another program, so Konfab didn't start.\n  See what it is: ${process.platform === "linux" ? `ss -ltnp 'sport = :${port}'` : `lsof -nP -iTCP:${port} -sTCP:LISTEN`}\n  Or give Konfab another port: set server.port in config.yaml (\`npm run doctor\` shows where it is).`,
    );
  }
  const child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env,
    stdio,
  });
  let exited = null;
  child.on("exit", (code) => (exited = code ?? 1));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited !== null)
      throw new Error(
        `The server stopped (exit code ${exited}) before it was ready; see its output above.`,
      );
    const ours = await answersAsOurs();
    if (ours) break;
    if (ours === false) {
      child.kill();
      throw new Error(
        `Something other than this Konfab answered on port ${port}; Konfab was stopped.`,
      );
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(
        `The server didn't answer within ${timeoutMs / 1000} seconds; it was stopped. Run \`npm run doctor\`.`,
      );
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  const link = loginLink();
  if (open) {
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
  return { status: "started", child, link };
}

function portFree(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
)
  void main();
