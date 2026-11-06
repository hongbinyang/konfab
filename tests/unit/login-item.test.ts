import { describe, expect, it } from "vitest";
import {
  LOGIN_ITEM_LABEL,
  loginItemPlist,
} from "../../src/cli/login-item-plist.js";

describe("loginItemPlist", () => {
  const plist = loginItemPlist({
    nodePath: "/envs/konfab/bin/node",
    serverPath: "/works/a&b/dist/server/index.js",
    workingDirectory: "/works/a&b",
    logPath: "/home/.konfab/logs/server.log",
  });

  it("uses absolute paths and starts at login", () => {
    expect(plist).toContain(LOGIN_ITEM_LABEL);
    expect(plist).toContain("<string>/envs/konfab/bin/node</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
  });

  it("restarts only after a crash", () => {
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
  });

  it("escapes special characters in paths", () => {
    expect(plist).toContain("/works/a&amp;b/dist/server/index.js");
    expect(plist).not.toContain("a&b");
  });
});
