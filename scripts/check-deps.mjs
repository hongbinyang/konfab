#!/usr/bin/env node
/* global process, console */
// Runs before every build: are the packages package-lock.json asks for
// installed here? Read-only and dependency-free. It never installs, because
// `npm ci` deletes node_modules first, which would break a Konfab server
// running from this checkout, or another checkout if node_modules is a link.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Packages that are missing or at another version than package-lock.json. */
export function dependencyProblems(projectRoot = root) {
  const { packages = {} } = JSON.parse(
    readFileSync(join(projectRoot, "package-lock.json"), "utf8"),
  );
  const problems = [];
  for (const [path, locked] of Object.entries(packages)) {
    // "" is this project; links are local folders.
    if (!path || locked.link || !locked.version) continue;
    let installed;
    try {
      installed = JSON.parse(
        readFileSync(join(projectRoot, path, "package.json"), "utf8"),
      ).version;
    } catch {
      // npm leaves out optional packages that don't fit this platform.
      if (locked.optional || locked.devOptional) continue;
    }
    if (installed !== locked.version)
      problems.push({
        name: path.slice(path.lastIndexOf("node_modules/") + 13),
        wanted: locked.version,
        installed,
      });
  }
  return problems;
}

export function describeProblems(problems, linked) {
  const shown = problems
    .slice(0, 5)
    .map(
      ({ name, wanted, installed }) =>
        `  ${name}: needs ${wanted}, ${installed ? `${installed} is installed` : "not installed"}`,
    );
  if (problems.length > 5) shown.push(`  … and ${problems.length - 5} more`);
  const fix = linked
    ? "node_modules here is a link to another folder. Don't run `npm ci` through it: it would delete that folder's packages. Update the dependencies in the folder it points to, or replace the link with a real install (`rm node_modules && npm ci`)."
    : "Stop Konfab if it is running from this folder, then run:\n\n  npm ci\n\nand run your command again.";
  return `\n✖ The installed packages don't match this version of Konfab (they usually change after an update):\n${shown.join("\n")}\n\n${fix}\n`;
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const problems = dependencyProblems();
  if (problems.length) {
    const linked =
      lstatSync(join(root, "node_modules"), {
        throwIfNoEntry: false,
      })?.isSymbolicLink() ?? false;
    console.error(describeProblems(problems, linked));
    process.exitCode = 1;
  }
}
