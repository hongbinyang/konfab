import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOG_NAME,
  LogFile,
  trimOutputFile,
} from "../../src/server/log-file.js";

describe("the server's log", () => {
  let root: string;
  let dir: string;
  let warnings: string[];
  let time: number;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "konfab-log-"));
    dir = join(root, "logs");
    warnings = [];
    time = 1_000;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const open = (maxBytes = 100, keep = 2) =>
    new LogFile(dir, {
      maxBytes,
      keep,
      now: () => time,
      warn: (message) => warnings.push(message),
    });
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  const line = (number: number) => `${String(number).padStart(29, "0")}\n`;

  it("stays within a fixed number of bounded files, newest first", () => {
    const log = open();
    for (let number = 1; number <= 50; number += 1) log.write(line(number));
    expect(readdirSync(dir).sort()).toEqual([
      LOG_NAME,
      `${LOG_NAME}.1`,
      `${LOG_NAME}.2`,
    ]);
    for (const name of readdirSync(dir))
      expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(100);
    // No line is lost or split at a rotation.
    expect(read(`${LOG_NAME}.2`) + read(`${LOG_NAME}.1`) + read(LOG_NAME)).toBe(
      [43, 44, 45, 46, 47, 48, 49, 50].map(line).join(""),
    );
    expect(warnings).toEqual([]);
  });

  it("continues after a restart, and rotates one that is already too big", () => {
    open().write(line(1));
    open().write(line(2));
    expect(read(LOG_NAME)).toBe(line(1) + line(2));
    appendFileSync(join(dir, LOG_NAME), "x".repeat(500));
    open().write(line(3));
    expect(read(LOG_NAME)).toBe(line(3));
    expect(read(`${LOG_NAME}.1`)).toContain("xxx");
  });

  it.skipIf(process.platform === "win32")(
    "is readable only by this user",
    () => {
      mkdirSync(dir, { mode: 0o755 });
      writeFileSync(join(dir, LOG_NAME), "", { mode: 0o644 });
      const log = open();
      for (let number = 1; number <= 5; number += 1) log.write(line(number));
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(dir))
        expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    },
  );

  it("replaces one huge line with a note", () => {
    const log = open(1_000_000);
    log.write(`${"secret".repeat(20_000)}\n`);
    expect(read(LOG_NAME)).toContain("120001 bytes was left out");
    expect(read(LOG_NAME)).not.toContain("secret");
  });

  it("never fails, warns once, and starts again when it can", () => {
    writeFileSync(dir, "not a folder");
    const log = open();
    for (let number = 1; number <= 5; number += 1)
      expect(() => log.write(line(number))).not.toThrow();
    time += 61_000;
    log.write(line(6));
    expect(warnings).toHaveLength(1);
    rmSync(dir);
    log.write(line(7));
    expect(existsSync(dir)).toBe(false);
    time += 61_000;
    log.write(line(8));
    expect(read(LOG_NAME)).toBe(line(8));
  });

  it.skipIf(process.platform === "win32")(
    "doesn't write through a link",
    () => {
      mkdirSync(dir);
      const other = join(root, "other.txt");
      writeFileSync(other, "keep");
      symlinkSync(other, join(dir, LOG_NAME));
      open().write(line(1));
      expect(readFileSync(other, "utf8")).toBe("keep");
      expect(warnings).toHaveLength(1);
    },
  );

  it("cuts other output to its last part while it is open for appending", () => {
    mkdirSync(dir);
    const path = join(dir, "output.log");
    trimOutputFile(path, 100, 20);
    expect(existsSync(path)).toBe(false);
    const writer = openSync(path, "a");
    writeSync(writer, "a".repeat(90));
    trimOutputFile(path, 100, 20);
    expect(statSync(path).size).toBe(90);
    writeSync(writer, "b".repeat(90));
    trimOutputFile(path, 100, 20);
    expect(readFileSync(path, "utf8")).toBe("b".repeat(20));
    writeSync(writer, "c");
    closeSync(writer);
    expect(readFileSync(path, "utf8")).toBe(`${"b".repeat(20)}c`);
  });
});
