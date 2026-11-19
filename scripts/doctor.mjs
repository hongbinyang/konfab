#!/usr/bin/env node
/* global process, console */
// `npm run doctor`: read-only checks that work even when dependencies are
// missing or broken. It installs, builds and writes nothing. Once dependencies
// load and Konfab is built, it runs the full read-only doctor.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installMatches } from "./quickstart.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lines = [];
let failed = false;
const ok = (check, detail) => lines.push(`ok    ${check}: ${detail}`);
const warn = (check, detail, fix) =>
  lines.push(`warn  ${check}: ${detail}${fix ? `\n      → ${fix}` : ""}`);
const fail = (check, detail, fix) => {
  failed = true;
  lines.push(`FAIL  ${check}: ${detail}${fix ? `\n      → ${fix}` : ""}`);
};

const newest = (dir) => {
  let latest = 0;
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else latest = Math.max(latest, statSync(full).mtimeMs);
    }
  };
  visit(dir);
  return latest;
};

const major = Number(process.versions.node.split(".")[0]);
if (major === 24) ok("Node", `Node ${process.versions.node}`);
else
  fail(
    "Node",
    `Node ${process.versions.node} is running; Konfab needs Node 24.`,
    process.platform === "darwin"
      ? "brew install node@24 (or nvm/fnm with this repo's .nvmrc)"
      : "nvm/fnm with this repo's .nvmrc, NodeSource, or nodejs.org",
  );

const modules = join(root, "node_modules");
let loads = false;
if (!existsSync(modules))
  fail("Dependencies", "Not installed.", "npm run quickstart");
else {
  loads =
    spawnSync(
      process.execPath,
      [
        "-e",
        "const D=require('better-sqlite3');new D(':memory:').prepare('select 1').get()",
      ],
      { cwd: root, stdio: "ignore", timeout: 20_000 },
    ).status === 0;
  if (!loads)
    fail(
      "Dependencies",
      "Installed, but the SQLite module doesn't load with this Node.",
      `npm run quickstart (reinstalls). If it has to compile, install build tools first: ${process.platform === "darwin" ? "xcode-select --install" : "sudo apt install build-essential python3"}`,
    );
  else if (lstatSync(modules).isSymbolicLink())
    warn(
      "Dependencies",
      "node_modules is a link to another folder.",
      "quickstart won't reinstall through it; replace it with a real install if this checkout should have its own.",
    );
  else if (!installMatches(root))
    warn(
      "Dependencies",
      "Not recorded for this lockfile, Node version and CPU.",
      "npm run quickstart (reinstalls with npm ci when they differ)",
    );
  else ok("Dependencies", "Installed and loading");
}

const built = join(root, "dist", "cli", "doctor.js");
if (!existsSync(built))
  fail("Build", "Konfab isn't built yet.", "npm run quickstart");
else if (newest(join(root, "src")) > statSync(built).mtimeMs)
  warn(
    "Build",
    "The built files are older than the source; the checks below may be out of date.",
    "npm run quickstart (or npm run build)",
  );
else ok("Build", "Up to date");

console.log(lines.join("\n"));
if (loads && existsSync(built)) {
  // The full checks, read-only: data folder, config, port, connectors, token.
  const full = spawnSync(process.execPath, [built], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, KONFAB_DOCTOR_BOOTSTRAPPED: "1" },
  });
  if (full.status !== 0) failed = true;
}
if (failed) process.exitCode = 1;
