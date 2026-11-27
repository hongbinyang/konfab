import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoginItem } from "../../src/server/connectors/login-item.js";

describe("start at login from the page", () => {
  let home: string;
  let calls: string[][];
  let loaded: boolean;
  const make = (platform: NodeJS.Platform = "darwin") =>
    new LoginItem({
      platform,
      home,
      uid: 501,
      plist: () => "<plist>this version</plist>",
      launchctl: (args) => {
        calls.push(args);
        return { code: args[0] === "print" ? (loaded ? 0 : 113) : 0 };
      },
    });
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "konfab-login-"));
    calls = [];
    loaded = false;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("writes the file for the next login, and never loads or starts it now", () => {
    const item = make();
    expect(item.view()).toMatchObject({
      available: true,
      file: "none",
      loaded: false,
    });
    item.turnOn();
    expect(readFileSync(item.path, "utf8")).toBe("<plist>this version</plist>");
    expect(statSync(item.path).mode & 0o777).toBe(0o600);
    expect(item.view().file).toBe("current");
    expect(calls.every(([verb]) => verb === "print")).toBe(true);
  });

  it("knows a file of an earlier version, and replaces it", () => {
    const item = make();
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(item.path, "<plist>old</plist>");
    expect(item.view().file).toBe("earlier");
    item.turnOn();
    expect(item.view().file).toBe("current");
  });

  it("turns off without stopping the running Konfab, unless unloading is chosen", () => {
    const item = make();
    item.turnOn();
    loaded = true;
    expect(item.view().loaded).toBe(true);
    item.turnOff(false);
    expect(item.view().file).toBe("none");
    expect(calls.some(([verb]) => verb === "bootout")).toBe(false);
    item.turnOff(true);
    expect(calls.filter(([verb]) => verb === "bootout")).toEqual([
      ["bootout", "gui/501/com.konfab.server"],
    ]);
  });

  it("is only on macOS, and writes through no link", () => {
    const other = make("linux");
    expect(other.view()).toMatchObject({ available: false });
    expect(() => other.turnOn()).toThrow(/service manager/);
    expect(calls).toEqual([]);
    const item = make();
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    const elsewhere = join(home, "elsewhere.plist");
    writeFileSync(elsewhere, "mine");
    symlinkSync(elsewhere, item.path);
    expect(() => item.turnOn()).toThrow(/link/);
    expect(readFileSync(elsewhere, "utf8")).toBe("mine");
  });
});
