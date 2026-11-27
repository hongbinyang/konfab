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
import { loginItemPlist } from "../../src/cli/login-item-plist.js";
import {
  earlierShapes,
  LoginItem,
} from "../../src/server/connectors/login-item.js";

const WD = "/Users/me/konfab";
const RUNNER = `${WD}/dist/cli/login-run.js`;
/** As the version before the runner wrote it. */
const before = (
  folder: string,
  node = "/usr/local/bin/node",
  log = "/Users/me/.konfab/logs/konfab.log",
) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.konfab.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${folder}/dist/server/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${folder}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
const EARLIER = before(WD);

describe("start at login from the page", () => {
  let home: string;
  let calls: string[][];
  let loaded: boolean;
  let bootout: { code: number | null } | "throws";
  const make = (platform: NodeJS.Platform = "darwin") =>
    new LoginItem({
      platform,
      home,
      uid: 501,
      plist: () =>
        loginItemPlist({
          nodePath: "/opt/node",
          runnerPath: RUNNER,
          workingDirectory: WD,
        }),
      earlier: earlierShapes({ runner: RUNNER, workingDirectory: WD }),
      launchctl: (args) => {
        calls.push(args);
        if (args[0] === "bootout") {
          if (bootout === "throws") throw new Error("spawn failed");
          return bootout;
        }
        return { code: loaded ? 0 : 113 };
      },
    });
  const put = (item: LoginItem, text: string) => {
    mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(item.path, text);
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "konfab-login-"));
    calls = [];
    loaded = false;
    bootout = { code: 0 };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("writes the file for the next login, and never loads or starts it now", () => {
    const item = make();
    const seen = item.view();
    expect(seen).toMatchObject({
      available: true,
      file: "none",
      loaded: false,
      stamp: "none",
    });
    item.turnOn(seen.stamp);
    expect(readFileSync(item.path, "utf8")).toContain(
      "<string>/opt/node</string>",
    );
    expect(statSync(item.path).mode & 0o777).toBe(0o600);
    expect(item.view().file).toBe("current");
    expect(calls.every(([verb]) => verb === "print")).toBe(true);
  });

  it("knows Konfab's earlier file, and leaves one it doesn't know alone", () => {
    const item = make();
    put(item, EARLIER);
    expect(item.view().file).toBe("earlier");
    item.turnOn(item.view().stamp);
    expect(item.view().file).toBe("current");
    // This version's with another Node (after a Node update): Konfab's too.
    put(
      item,
      loginItemPlist({
        nodePath: "/usr/bin/node",
        runnerPath: RUNNER,
        workingDirectory: WD,
      }),
    );
    expect(item.view().file).toBe("earlier");
    // The label and the word, but not exactly a shape Konfab wrote here.
    for (const other of [
      "<plist><string>com.konfab.server</string><!-- konfab --></plist>",
      before("/Users/me/other-konfab"),
      EARLIER.replace("<true/>", "<false/>"),
      EARLIER.replace(
        "<key>StandardErrorPath</key>\n  <string>/Users/me/.konfab/logs/konfab.log</string>",
        "<key>StandardErrorPath</key>\n  <string>/tmp/other.log</string>",
      ),
      `${EARLIER}<!-- added -->`,
      `<!-- added -->${EARLIER}`,
    ]) {
      put(item, other);
      expect(item.view().file, other.slice(-40)).toBe("unknown");
    }
    put(
      item,
      "<plist><string>com.konfab.server</string><string>/opt/other/run</string></plist>",
    );
    const seen = item.view();
    expect(seen.file).toBe("unknown");
    expect(() => item.turnOn(seen.stamp)).toThrow(/leaves it alone/);
    expect(() => item.turnOff(seen.stamp)).toThrow(/leaves it alone/);
    expect(readFileSync(item.path, "utf8")).toContain("/opt/other/run");
  });

  it.each<[string, (item: LoginItem) => void]>([
    ["changed", (item) => writeFileSync(item.path, `${EARLIER}\n`)],
    [
      "replaced",
      (item) => {
        rmSync(item.path);
        writeFileSync(item.path, EARLIER);
      },
    ],
    [
      "made a link",
      (item) => {
        const elsewhere = join(home, "elsewhere.plist");
        writeFileSync(elsewhere, EARLIER);
        rmSync(item.path);
        symlinkSync(elsewhere, item.path);
      },
    ],
    ["removed", (item) => rmSync(item.path)],
  ])(
    "does nothing when the file was %s after the question",
    (_name, change) => {
      for (const turn of ["on", "off"] as const) {
        const item = make();
        put(item, EARLIER);
        const { stamp } = item.view();
        change(item);
        const before = item.view().stamp;
        expect(() =>
          turn === "on" ? item.turnOn(stamp) : item.turnOff(stamp),
        ).toThrow(/changed since/);
        expect(item.view().stamp).toBe(before);
        rmSync(item.path, { force: true });
      }
    },
  );

  it("turns off without stopping the running Konfab; unloading is its own step and never throws", () => {
    const item = make();
    item.turnOn(item.view().stamp);
    loaded = true;
    item.turnOff(item.view().stamp);
    expect(item.view().file).toBe("none");
    expect(calls.some(([verb]) => verb === "bootout")).toBe(false);
    item.unload();
    expect(calls.filter(([verb]) => verb === "bootout")).toEqual([
      ["bootout", "gui/501/com.konfab.server"],
    ]);
    expect(item.view().last_unload).toEqual({ ok: true, said: "Unloaded." });
    for (const [given, said] of [
      [{ code: 5 }, /refused.*code 5/],
      [{ code: null }, /didn't answer in time/],
      ["throws", /couldn't be unloaded/],
    ] as const) {
      bootout = given;
      expect(() => item.unload()).not.toThrow();
      expect(item.view().last_unload).toMatchObject({
        ok: false,
        said: expect.stringMatching(said),
      });
    }
  });

  it("is only on macOS", () => {
    const other = make("linux");
    expect(other.view()).toMatchObject({ available: false });
    expect(() => other.turnOn("none")).toThrow(/service manager/);
    expect(() => other.unload()).toThrow(/service manager/);
    expect(calls).toEqual([]);
  });
});
