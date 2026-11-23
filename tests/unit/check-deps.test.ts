import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(
  import.meta.dirname,
  "../..",
  "scripts",
  "check-deps.mjs",
);

describe("the dependency check before a build", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "konfab-check-deps-"));
    mkdirSync(join(dir, "scripts"));
    cpSync(script, join(dir, "scripts", "check-deps.mjs"));
    lock({
      "node_modules/one": { version: "1.0.0" },
      "node_modules/one/node_modules/@scope/two": { version: "2.0.0" },
      "node_modules/other-platform": { version: "1.0.0", optional: true },
    });
    install("node_modules/one", "1.0.0");
    install("node_modules/one/node_modules/@scope/two", "2.0.0");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lock = (packages: Record<string, unknown>) =>
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ packages: { "": { name: "app" }, ...packages } }),
    );
  const install = (path: string, version: string) => {
    const file = join(dir, path, "package.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version }));
  };
  const check = () => {
    const result = spawnSync(
      process.execPath,
      [join(dir, "scripts", "check-deps.mjs")],
      { encoding: "utf8" },
    );
    return { status: result.status, message: result.stderr };
  };

  it("passes quietly when the installed packages match, again and again", () => {
    for (let run = 0; run < 2; run += 1)
      expect(check()).toEqual({ status: 0, message: "" });
  });

  it("stops after an update that added or changed packages, and says what to run", () => {
    lock({
      "node_modules/one": { version: "1.1.0" },
      "node_modules/one/node_modules/@scope/two": { version: "2.0.0" },
      "node_modules/new": { version: "3.0.0" },
    });
    const { status, message } = check();
    expect(status).toBe(1);
    expect(message).toContain("one: needs 1.1.0, 1.0.0 is installed");
    expect(message).toContain("new: needs 3.0.0, not installed");
    expect(message).not.toContain("@scope/two");
    expect(message).toContain("Stop Konfab if it is running");
    expect(message).toContain("npm ci");
    // Installing what was asked for clears it.
    install("node_modules/one", "1.1.0");
    install("node_modules/new", "3.0.0");
    expect(check().status).toBe(0);
  });

  it("stops when nothing is installed or an install was interrupted", () => {
    rmSync(join(dir, "node_modules", "one", "node_modules"), {
      recursive: true,
    });
    expect(check().message).toContain("@scope/two: needs 2.0.0, not installed");
    rmSync(join(dir, "node_modules"), { recursive: true });
    expect(check().status).toBe(1);
  });

  it("never tells anyone to install through a linked node_modules, and changes nothing", () => {
    renameSync(join(dir, "node_modules"), join(dir, "shared"));
    symlinkSync(join(dir, "shared"), join(dir, "node_modules"), "junction");
    expect(check().status).toBe(0);
    install("node_modules/one", "0.9.0");
    const before = readdirSync(join(dir, "shared"));
    const { status, message } = check();
    expect(status).toBe(1);
    expect(message).toContain("Don't run `npm ci` through it");
    expect(message).not.toContain("Stop Konfab if it is running");
    expect(readdirSync(join(dir, "shared"))).toEqual(before);
  });

  it("runs first in every build, so a stopped build leaves the built files alone", () => {
    const { scripts } = JSON.parse(
      readFileSync(resolve(dirname(script), "..", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(scripts.build).toMatch(/^node scripts\/check-deps\.mjs && /);
    for (const name of ["start", "setup", "login-link"])
      expect(scripts[name]).toMatch(/^npm run build\b/);
  });
});
