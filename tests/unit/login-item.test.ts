import { describe, expect, it } from "vitest";
import {
  LOGIN_ITEM_LABEL,
  loginItemPlist,
} from "../../src/cli/login-item-plist.js";

describe("loginItemPlist", () => {
  const plist = loginItemPlist({
    nodePath: "/envs/konfab/bin/node",
    runnerPath: "/works/a&b/dist/cli/login-run.js",
    workingDirectory: "/works/a&b",
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

  it("keeps no file that macOS would let grow without a limit", () => {
    expect(
      plist.match(
        /<key>Standard(Out|Error)Path<\/key>\s*<string>\/dev\/null<\/string>/g,
      ),
    ).toHaveLength(2);
  });

  it("escapes special characters in paths", () => {
    expect(plist).toContain("/works/a&amp;b/dist/cli/login-run.js");
    expect(plist).not.toContain("a&b");
  });
});
