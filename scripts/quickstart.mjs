#!/usr/bin/env node
/* global process, console, setTimeout, URL */
// Get Konfab running from a fresh clone: check Node, install dependencies when
// they don't match, build, set up the app connectors, report problems, then
// start. Safe to run again. Plain Node with no dependencies, so it works before
// `npm ci`. `--check` runs the isolated end-to-end check instead of starting;
// `--konfab-stopped` allows a reinstall where it can't tell if Konfab is running.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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

/**
 * This user's processes that have a file under node_modules loaded, such as
 * a running Konfab server (its SQLite module). Asks the operating system, so
 * ports and homes don't matter and nothing is contacted. Returns null when it
 * can't be told; processes of other users aren't visible.
 */
export function processesUsing(
  modules,
  { platform = process.platform, run = spawnSync } = {},
) {
  const inside = `${realpathSync(modules)}/`;
  const users = new Set();
  if (platform === "linux") {
    try {
      const uid = process.getuid();
      for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
        try {
          if (statSync(`/proc/${pid}`).uid !== uid) continue;
          if (readFileSync(`/proc/${pid}/maps`, "utf8").includes(inside))
            users.add(Number(pid));
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ESRCH") continue;
          // Some programs hide their maps (ssh-agent); a hidden Node can't be ruled out.
          const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
          if (/node|MainThread/i.test(name)) return null;
        }
      }
      return [...users];
    } catch {
      return null;
    }
  }
  // lsof writes other characters in paths in escaped form.
  if (platform !== "darwin" || !/^[\x20-\x7e]+$/.test(inside)) return null;
  const listed = run(
    "/usr/sbin/lsof",
    ["-nP", "-w", "-u", String(process.getuid()), "-Fpn"],
    { encoding: "utf8", timeout: 20_000, maxBuffer: 256 * 1024 * 1024 },
  );
  let pid = 0;
  let sawItself = false;
  for (const line of (listed.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      if (pid === process.pid) sawItself = true;
    } else if (line.startsWith(`n${inside}`)) users.add(pid);
  }
  // lsof's exit code isn't reliable; a complete list includes this process.
  return users.size || (sawItself && !listed.error) ? [...users] : null;
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
    // Reinstalling would also pull the packages from under a running server.
    if (lstatSafe(modules)) {
      const users = processesUsing(modules);
      const stopIt =
        "Stop it (Ctrl+C in its terminal, or `npm run login-item -- uninstall` if it starts at login), then run `npm run quickstart` again.";
      if (users?.length)
        stop(
          `The dependencies need reinstalling, but a running program uses them (process ${users.join(", ")}); it is probably Konfab. Nothing was changed.\n  ${stopIt}\n  To see it: \`ps -p ${users.join(",")} -o pid,command\``,
        );
      if (users === null && !args.has("--konfab-stopped"))
        stop(
          `The dependencies need reinstalling, and quickstart can't tell here whether Konfab is running from this folder. Nothing was changed.\n  If it is: ${stopIt}\n  Once you are sure it isn't, run \`npm run quickstart -- --konfab-stopped\`.`,
        );
    }
    // The SQLite module is compiled when no prebuilt binary fits (always so on
    // Linux in our tests); say up front if the usual tools are missing.
    const missing = ["python3", "make", "c++"].filter(
      (tool) =>
        process.platform !== "win32" &&
        spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" })
          .status !== 0,
    );
    if (missing.length)
      say(
        `! ${missing.join(", ")} not found. If npm has to compile the SQLite module, it needs them: ${buildTools}`,
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
  let started;
  try {
    started = await startKonfab({ open: !args.has("--no-open") });
  } catch (error) {
    stop(error.message);
  }
  say(`\nKonfab is running. Sign in: ${started.link}`);
  started.child.on("exit", (code) => process.exit(code ?? 0));
  say(
    "Next: restart (or reload the Konfab connector in) your agent app, then paste a join prompt from the page.\n" +
      "An agent is connected when its card says “Waiting for a turn”. Press Ctrl+C to stop Konfab.",
  );
}

/**
 * Starts the server and returns once that child process itself reports it is
 * listening; then makes a sign-in link from the local database. Nothing is
 * sent over the network, so no sign-in code can reach another program. A busy
 * port, a server that stops or never reports ready, and a failed sign-in link
 * are errors with the next step; on any error after starting, the server is
 * stopped and reaped.
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
  // The port as Konfab will use it, from the parsed config (login-link reads it).
  const port = Number(new URL(loginLink()).port);
  if (!(await portFree(port)))
    throw new Error(
      `Port ${port} is already in use, so Konfab didn't start.\n` +
        `  If Konfab is already running from this install, get a new sign-in link with \`npm run login-link\`.\n` +
        `  Otherwise see what uses it: ${process.platform === "linux" ? `ss -ltnp 'sport = :${port}'` : `lsof -nP -iTCP:${port} -sTCP:LISTEN`}\n` +
        `  or give Konfab another port: set server.port in config.yaml (\`npm run doctor\` shows where it is).`,
    );
  const child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env,
    stdio: [stdio === "inherit" ? "inherit" : "ignore", stdio, stdio, "ipc"],
  });
  const exited = new Promise((done) =>
    child.once("exit", (code) => done(code ?? 1)),
  );
  const stopChild = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await exited;
  };
  try {
    const ready = new Promise((done) =>
      child.on("message", (message) => {
        if (message?.type === "konfab-ready" && message.port === port)
          done("ready");
      }),
    );
    const timer = new Promise((done) =>
      setTimeout(() => done("timeout"), timeoutMs),
    );
    const outcome = await Promise.race([
      ready,
      timer,
      exited.then((code) => ({ code })),
    ]);
    if (outcome === "timeout")
      throw new Error(
        `The server didn't report ready within ${timeoutMs / 1000} seconds; it was stopped. Run \`npm run doctor\`.`,
      );
    if (typeof outcome === "object")
      throw new Error(
        `The server stopped (exit code ${outcome.code}) before it was ready; see its output above.`,
      );
    child.disconnect?.();
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
  } catch (error) {
    await stopChild();
    throw error;
  }
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
