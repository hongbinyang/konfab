import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfig, type ConfigDeps } from "../../src/cli/config.js";
import { configPath, parseConfig } from "../../src/server/config.js";
import {
  LiveSettings,
  readInUse,
  type InUse,
} from "../../src/server/live-settings.js";
import {
  changeSettings,
  checked,
  edited,
  readSettingsFile,
  SettingsError,
  tidySettingsFiles,
} from "../../src/server/settings-file.js";
import {
  approvalChange,
  unusedKeys,
  defaultOf,
  EFFECT,
  SETTINGS,
  settingFor,
  shown,
  valueAt,
} from "../../src/server/settings.js";

let home: string;
const put = (text: string) => writeFileSync(configPath(home), text);
const text = () => readFileSync(configPath(home), "utf8");
const kept = () => {
  try {
    return readdirSync(join(home, "backups", "config"))
      .sort()
      .map((name) =>
        readFileSync(join(home, "backups", "config", name), "utf8"),
      );
  } catch {
    return [];
  }
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "konfab-settings-"));
  chmodSync(home, 0o700);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const leaves = (value: object, at = ""): string[] =>
  Object.entries(value).flatMap(([key, inner]) => {
    const path = at ? `${at}.${key}` : key;
    return typeof inner === "object" &&
      inner !== null &&
      !Array.isArray(inner) &&
      !["agents"].includes(path)
      ? leaves(inner as object, path)
      : [path];
  });

describe("the one list", () => {
  it("has every key of the schema, and no other", () => {
    expect(SETTINGS.map(({ key }) => key).sort()).toEqual(
      leaves(parseConfig("")).sort(),
    );
  });

  it("fits the schema in its limits and kinds", () => {
    for (const { key, control, page } of SETTINGS) {
      const [section, name] = key.split(".") as [string, string];
      const fits = (value: unknown) => {
        try {
          checked(JSON.stringify({ [section]: { [name]: value } }));
          return true;
        } catch {
          return false;
        }
      };
      if (control.type === "switch") {
        expect([fits(true), fits("x")], key).toEqual([true, false]);
      } else if (control.type === "time") {
        expect(["22:00", null, "24:00", "9:00"].map(fits), key).toEqual([
          true,
          true,
          false,
          false,
        ]);
      } else if (control.type === "number" && page !== "later") {
        // The page may be stricter than the file, never looser.
        const { min, max } = control;
        expect([min, max, min - 1, min + 0.5].map(fits), key).toEqual([
          true,
          true,
          false,
          control.decimal === true,
        ]);
      }
    }
  });

  it("is the table in the user guide", () => {
    const guide = readFileSync("docs/user-guide.md", "utf8");
    for (const { key, effect, page } of SETTINGS) {
      if (effect === "never") continue;
      const row = guide
        .split("\n")
        .find((line) => line.startsWith(`| \`${key}\``));
      expect(row, `${key} in the guide`).toBeTruthy();
      // In the page, and in use.
      const cells = row!.split("|").map((cell) => cell.trim());
      expect(cells[3], key).toBe(
        page === "edit" ? "yes" : page === "ask" ? "with a question" : "no",
      );
      expect(cells[4], key).toBe(EFFECT[effect]);
      const usual = defaultOf(key);
      if (key !== "agents" && key !== "pre_approvals")
        expect(row, key).toContain(
          Array.isArray(usual) ? usual.join(", ") : shown(usual),
        );
    }
  });

  it("knows a single agent's settings, and nothing else", () => {
    expect(settingFor("agents.claude.run_hours")).toMatchObject({
      effect: "next_join",
      page: "edit",
      control: { type: "number", min: 1, max: 24, decimal: true },
    });
    expect(settingFor("agents.claude.display_name")).toMatchObject({
      effect: "now",
      page: "edit",
    });
    expect(settingFor("agents.claude.hours")).toBeNull();
    expect(settingFor("defaults.hours")).toBeNull();
    for (const key of [
      "agents.Claude",
      "agents.a.token",
      "__proto__.x",
      "rejoin",
      "rejoin.enabled.x",
      "ui.role_picker",
    ])
      expect(settingFor(key), key).toBeNull();
    expect(valueAt({}, "constructor.name")).toBeUndefined();
  });
});

describe("changing config.yaml", () => {
  const OLD = `# mine
server:
  port: 8787 # not 8000

ui:
  role_picker: true

# wakes Claude
rejoin:
  claude_watcher: true

pre_approvals: []
#  - recipient: github.com/OWNER/REPO
#    data: code_push
`;

  it("changes one value and nothing else", () => {
    expect(edited(OLD, { set: { "rejoin.claude_watcher": false } })).toBe(
      OLD.replace("claude_watcher: true", "claude_watcher: false"),
    );
  });

  it("adds a section at the very end, after the comments there", () => {
    expect(edited(OLD, { set: { "phone_notices.away_minutes": 5 } })).toBe(
      `${OLD}\nphone_notices:\n  away_minutes: 5\n`,
    );
  });

  it("adds a key to its own section, and removes what it added", () => {
    const more = edited(OLD, { set: { "rejoin.wanted_minutes": 20 } });
    expect(parse(more)).toMatchObject({
      rejoin: { claude_watcher: true, wanted_minutes: 20 },
      ui: { role_picker: true },
    });
    for (const comment of OLD.match(/#.*/g)!) expect(more).toContain(comment);
    const less = edited(more, { reset: ["rejoin.wanted_minutes"] });
    expect(parse(less)).toEqual(parse(OLD));
    const none = edited(less, { reset: ["rejoin.claude_watcher"] });
    expect(parse(none)).not.toHaveProperty("rejoin");
    expect(parse(none)).toMatchObject({ ui: { role_picker: true } });
  });

  it.each([
    ["an empty file", ""],
    ["only a comment", "# nothing yet\n"],
    ["flow style", "{server: {port: 9000}}\n"],
    ["quotes", '"server": {"port": 9000}\n'],
    ["no last line end", "server:\n  port: 9000"],
    ["its own key", "phone_notices:\n  max_per_day: 3\n"],
  ])("works with %s", (_what, before) => {
    const after = edited(before, { set: { "phone_notices.away_minutes": 5 } });
    const old = (parse(before) ?? {}) as Record<string, object>;
    expect(parse(after)).toEqual({
      ...old,
      phone_notices: { ...old.phone_notices, away_minutes: 5 },
    });
  });

  it("keeps Windows line ends", () => {
    const after = edited(OLD.replace(/\n/g, "\r\n"), {
      set: { "rejoin.claude_watcher": false },
    });
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
    expect(after).toBe(
      OLD.replace("claude_watcher: true", "claude_watcher: false").replace(
        /\n/g,
        "\r\n",
      ),
    );
  });

  it.each([
    ["a shared value", "a: &x\n  enabled: true\nrejoin: *x\n"],
    ["a second document", "server:\n  port: 9000\n---\na: 1\n"],
    ["a doubled key", "rejoin: {}\nrejoin: {}\n"],
    ["a list", "- 1\n"],
    ["broken", "rejoin: {\n"],
    ["merged keys", "x: &x {a: 1}\nrejoin:\n  <<: *x\n"],
  ])("changes nothing it can't change safely: %s", (_what, before) => {
    let after: string | undefined;
    try {
      after = edited(before, { set: { "rejoin.enabled": false } });
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsError);
      return;
    }
    // Or it did exactly what was asked.
    expect(parse(after)).toEqual({
      ...(parse(before) as object),
      rejoin: {
        ...(parse(before) as { rejoin: object }).rejoin,
        enabled: false,
      },
    });
  });

  it("never changes another value along with it", () => {
    const shared = "rejoin: &r\n  enabled: true\nui: *r\n";
    expect(() => edited(shared, { set: { "rejoin.enabled": false } })).toThrow(
      /by hand/,
    );
  });

  it("writes it whole and private, and keeps the last five", async () => {
    put(OLD);
    for (let minutes = 1; minutes <= 7; minutes += 1)
      await changeSettings(home, {
        set: { "rejoin.wanted_minutes": minutes },
      });
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    expect(kept()).toHaveLength(5);
    expect(parse(kept().at(-1)!)).toMatchObject({
      rejoin: { wanted_minutes: 6 },
    });
    const folder = join(home, "backups", "config");
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(folder))
      expect(statSync(join(folder, name)).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it.each([
    [{ set: { "rejoin.wanted_minutes": 0 } }, "invalid"],
    [{ set: { "rejoin.wanted_minutes": "ten" } }, "invalid"],
    [{ set: { "phone_notices.quiet_from": "25:00" } }, "invalid"],
    [{ set: { "server.port": 80 } }, "invalid"],
    [{ set: { "ui.role_picker": false } }, "unknown"],
    [{ reset: ["everything"] }, "unknown"],
  ])("writes nothing that doesn't fit (%#)", async (change, code) => {
    put(OLD);
    await expect(changeSettings(home, change)).rejects.toMatchObject({ code });
    expect(text()).toBe(OLD);
    expect(kept()).toEqual([]);
  });

  it("is a no-op that keeps nothing when the value is as before", async () => {
    put(OLD);
    const done = await changeSettings(home, {
      set: { "rejoin.claude_watcher": true },
    });
    expect(done.changed).toBe(false);
    expect([text(), kept()]).toEqual([OLD, []]);
  });

  it("refuses a file that isn't the one that was shown", async () => {
    put(OLD);
    const { hash } = readSettingsFile(home);
    put(`${OLD}\n# later\n`);
    await expect(
      changeSettings(home, { set: { "rejoin.enabled": false } }, hash),
    ).rejects.toMatchObject({ code: "changed" });
    expect(text()).toBe(`${OLD}\n# later\n`);
  });

  it("sees an editor up to the last look, and says what is lost after it", async () => {
    put(OLD);
    const mine = `${OLD}# by an editor\n`;
    await expect(
      changeSettings(home, { set: { "rejoin.enabled": false } }, undefined, {
        look: () => put(mine),
      }),
    ).rejects.toMatchObject({ code: "changed" });
    expect(text()).toBe(mine);
    // Between the last look and the rename: the editor's is gone. Known, and
    // in the guide; the kept one is what Konfab had read.
    put(OLD);
    await changeSettings(
      home,
      { set: { "rejoin.enabled": false } },
      undefined,
      { rename: () => put(mine) },
    );
    expect(text()).not.toContain("by an editor");
    expect(kept().some((file) => file.includes("by an editor"))).toBe(false);
    // The other way round: an editor with the old text overwrites the change.
    put(OLD);
    expect(text()).not.toContain("enabled: false");
  });

  it("never goes through a link, also one that is put there meanwhile", async () => {
    const other = join(home, "other.yaml");
    writeFileSync(other, OLD);
    symlinkSync(other, configPath(home));
    await expect(
      changeSettings(home, { set: { "rejoin.enabled": false } }),
    ).rejects.toMatchObject({ code: "unsafe" });
    rmSync(configPath(home));
    put(OLD);
    await changeSettings(
      home,
      { set: { "rejoin.enabled": false } },
      undefined,
      {
        rename: () => {
          rmSync(configPath(home));
          symlinkSync(other, configPath(home));
        },
      },
    );
    expect(readFileSync(other, "utf8")).toBe(OLD);
    expect(statSync(configPath(home)).isFile()).toBe(true);
    rmSync(configPath(home));
    linkSync(other, configPath(home));
    await expect(
      changeSettings(home, { set: { "rejoin.enabled": false } }),
    ).rejects.toMatchObject({ code: "unsafe" });
    rmSync(configPath(home));
    mkdirSync(configPath(home));
    await expect(
      changeSettings(home, { set: { "rejoin.enabled": false } }),
    ).rejects.toMatchObject({ code: "unsafe" });
  });

  it("refuses a folder that others can change, and a read-only file", async () => {
    put(OLD);
    chmodSync(home, 0o777);
    const change = () =>
      changeSettings(home, { set: { "rejoin.enabled": false } });
    await expect(change()).rejects.toMatchObject({ code: "unsafe" });
    chmodSync(home, 0o700);
    chmodSync(configPath(home), 0o400);
    await expect(change()).rejects.toMatchObject({ code: "unsafe" });
    expect(text()).toBe(OLD);
  });

  it("is done one after the other, and a dead writer holds nobody up", async () => {
    put(OLD);
    const lock = new Database(join(home, "config.lock"));
    lock.exec("BEGIN IMMEDIATE");
    let saved = false;
    const change = changeSettings(home, {
      set: { "rejoin.enabled": false },
    }).then(() => (saved = true));
    await new Promise((done) => setTimeout(done, 150));
    expect(saved).toBe(false);
    lock.close();
    await change;
    // A process that dies with the lock.
    const died = spawnSync(
      process.execPath,
      [
        "-e",
        `const D=require("better-sqlite3");const d=new D(process.argv[1]);d.exec("BEGIN IMMEDIATE");process.kill(process.pid,"SIGKILL")`,
        join(home, "config.lock"),
      ],
      { cwd: process.cwd() },
    );
    expect(died.signal).toBe("SIGKILL");
    await changeSettings(home, { set: { "rejoin.enabled": true } });
    expect(parse(text())).toMatchObject({ rejoin: { enabled: true } });
  });

  it("keeps both of two changes at the same moment, and refuses the one that was shown an older file", async () => {
    put(OLD);
    await Promise.all([
      changeSettings(home, { set: { "rejoin.enabled": false } }),
      changeSettings(home, { set: { "rejoin.open_apps": false } }),
    ]);
    expect(parse(text())).toMatchObject({
      rejoin: { enabled: false, open_apps: false },
    });
    const { hash } = readSettingsFile(home);
    const both = await Promise.allSettled([
      changeSettings(home, { set: { "rejoin.wanted_minutes": 1 } }, hash),
      changeSettings(home, { set: { "rejoin.wanted_minutes": 2 } }, hash),
    ]);
    expect(both.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  it("removes what a process left that died while it saved", () => {
    put(OLD);
    const left = `.config-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.tmp`;
    writeFileSync(join(home, left), "x");
    writeFileSync(join(home, ".config-mine.tmp"), "x");
    tidySettingsFiles(home);
    expect(readdirSync(home).sort()).toEqual([
      ".config-mine.tmp",
      "config.yaml",
    ]);
  });
});

describe("a running server", () => {
  let applied: string[];
  let warned: string[];
  let live: LiveSettings;
  const make = () => {
    applied = [];
    warned = [];
    live = new LiveSettings(
      {
        home,
        port: 18000,
        apply: (next) =>
          applied.push(
            `${next.phone_notices.away_minutes} ${next.rejoin.wanted_minutes}`,
          ),
        changed: () => undefined,
        warn: (message) => warned.push(message),
      },
      {
        config: parseConfig(text()),
        hash: readSettingsFile(home).hash,
      },
    );
    live.look();
    return live;
  };
  const note = () => readInUse(home) as InUse;

  it("takes on what it can, and says what waits for a restart", () => {
    put("server:\n  port: 9000\n");
    make();
    expect(applied).toEqual([]);
    put("server:\n  port: 9001\nphone_notices:\n  away_minutes: 3\n");
    live.look(true);
    expect(applied).toEqual(["3 10"]);
    expect(live.inUse.server.port).toBe(9000);
    expect(live.saved.server.port).toBe(9001);
    expect(note()).toMatchObject({
      pid: process.pid,
      hash: live.hash,
      problem: null,
      waiting: ["server.port"],
    });
    expect(statSync(join(home, "in-use.json")).mode & 0o777).toBe(0o600);
  });

  it("sees a change by itself, by its time, size or identity", () => {
    put("rejoin:\n  wanted_minutes: 5\n");
    make();
    put("rejoin:\n  wanted_minutes: 6\n");
    utimesSync(configPath(home), new Date(), new Date(Date.now() + 5_000));
    live.look();
    expect(applied).toEqual(["10 6"]);
    live.look();
    expect(applied).toHaveLength(1);
  });

  it.each([
    ["broken", "rejoin: {\n", "line"],
    ["not fitting", "rejoin:\n  wanted_minutes: 0\n", "rejoin.wanted_minutes"],
    ["too large", `# ${"x".repeat(1024 * 1024)}\n`, "too large"],
  ])("stays as it is with a %s file, and says why", (_what, wrong, why) => {
    put("rejoin:\n  wanted_minutes: 5\n");
    make();
    put(wrong);
    live.look(true);
    live.look(true);
    expect(applied).toEqual([]);
    expect(live.problem).toContain(why);
    expect(warned).toHaveLength(1);
    expect(note().problem).toContain(why);
    expect(live.inUse.rejoin.wanted_minutes).toBe(5);
    put("rejoin:\n  wanted_minutes: 7\n");
    live.look(true);
    expect(live.problem).toBeNull();
    expect(applied).toEqual(["10 7"]);
  });

  it("survives a missing file and a link", () => {
    put("rejoin:\n  wanted_minutes: 5\n");
    make();
    rmSync(configPath(home));
    live.look(true);
    expect(live.problem).toContain("can't be read");
    writeFileSync(join(home, "other"), "rejoin:\n  wanted_minutes: 9\n");
    symlinkSync(join(home, "other"), configPath(home));
    live.look(true);
    expect(live.problem).toContain("link");
    expect(applied).toEqual([]);
  });

  it("says nothing that isn't known of it any more", () => {
    put("");
    expect(readInUse(home)).toBe("none");
    make();
    const now = Date.now();
    expect(readInUse(home, now)).toMatchObject({ port: 18000 });
    expect(readInUse(home, now + 26_000)).toBe("unsure");
    expect(readInUse(home, now, () => false)).toBe("none");
    writeFileSync(join(home, "in-use.json"), "{");
    expect(readInUse(home)).toBe("unsure");
    live.stop();
    expect(readInUse(home)).toBe("none");
  });
});

describe("npm run config", () => {
  let said: string[];
  let asked: string[];
  let deps: ConfigDeps;
  const run = async (...args: string[]) => {
    said = [];
    const code = await runConfig(args, deps);
    return [code, ...said] as [number, ...string[]];
  };
  const noteOf = (overrides: Partial<InUse> = {}): InUse => ({
    pid: 1,
    port: 8787,
    started_at: 0,
    seen_at: 0,
    hash: readSettingsFile(home).hash,
    problem: null,
    waiting: [],
    ...overrides,
  });
  beforeEach(() => {
    put("# mine\nrejoin:\n  claude_watcher: true\n");
    asked = [];
    deps = {
      home,
      say: (line) => said.push(line),
      ask: async (question) => {
        asked.push(question);
        return "y";
      },
      sleep: async () => undefined,
      waitMs: 0,
      inUse: () => "none",
      look: async (path) => ({ ok: true, path, stamp: "1", signed_by: null }),
    };
  });

  it("shows all settings, with what isn't the default", async () => {
    const [code, ...lines] = await run();
    expect(code).toBe(0);
    for (const { key } of SETTINGS)
      expect(lines.some((line) => line.startsWith(`${key}: `))).toBe(true);
    expect(lines).toContain("rejoin.claude_watcher: true (default: false)");
    expect(lines).toContain("rejoin.enabled: true");
  });

  it("gets, sets and resets, and says when it is in use", async () => {
    expect(await run("get", "rejoin.wanted_minutes")).toEqual([
      0,
      "rejoin.wanted_minutes: 10",
      "How long a request to rejoin stays wanted. At once.",
    ]);
    expect(await run("set", "rejoin.wanted_minutes", "20")).toEqual([
      0,
      "rejoin.wanted_minutes: 10 → 20",
      "Saved. Konfab isn't running from this folder; used at the next start.",
    ]);
    expect(text()).toContain("# mine");
    deps.inUse = () => noteOf();
    expect(await run("reset", "rejoin.wanted_minutes")).toEqual([
      0,
      "rejoin.wanted_minutes: 20 → 10",
      "In use.",
    ]);
    expect((await run("set", "rejoin.claude_watcher", "false")).at(-1)).toMatch(
      /^In use\. An agent takes part from its next join/,
    );
    expect(await run("set", "rejoin.claude_watcher", "false")).toContain(
      "rejoin.claude_watcher: false, as before",
    );
    deps.inUse = () => noteOf({ waiting: ["server.port"], port: 8787 });
    expect((await run("set", "server.port", "9000")).at(-1)).toBe(
      "Saved. The running Konfab (port 8787) uses it after a restart.",
    );
  });

  it("doesn't take another, a stuck or an unclear server for this one", async () => {
    const answers: [() => ReturnType<ConfigDeps["inUse"]>, RegExp][] = [
      [() => "unsure", /hasn't confirmed it/],
      // One that looks at another file, or hasn't looked yet.
      [() => noteOf({ hash: "0" }), /hasn't confirmed it/],
      [
        () => noteOf({ problem: "config.yaml is a link" }),
        /not in use: .*link/,
      ],
    ];
    let minutes = 10;
    for (const [inUse, said] of answers) {
      deps.inUse = inUse;
      minutes += 1;
      expect(
        (await run("set", "rejoin.wanted_minutes", String(minutes))).at(-1),
      ).toMatch(said);
    }
    // One that follows a moment later.
    let looks = 0;
    deps.waitMs = 5_000;
    deps.inUse = () => noteOf((looks += 1) > 2 ? {} : { hash: "0" });
    expect((await run("set", "rejoin.wanted_minutes", "30")).at(-1)).toBe(
      "In use.",
    );
  });

  it.each([
    [["set", "rejoin.wanted_minutes", "0"], 1, /^Not changed: rejoin/],
    [["set", "rejoin.wanted_minutes", "a b"], 1, /^Not changed: rejoin/],
    [["set", "rejoin.wanted_minutes", "{"], 1, /can't be read/],
    [["set", "rejoin.enabled"], 2, /^Usage/],
    [["set", "rejoin.nothing", "1"], 2, /isn't a setting/],
    [["get"], 2, /^Usage/],
    [["reset", "rejoin.enabled", "x"], 2, /^Usage/],
    [["delete", "rejoin.enabled"], 2, /^Usage/],
  ])(
    "changes nothing when it is asked wrongly (%#)",
    async (args, code, said) => {
      const before = text();
      const [got, first] = await run(...args);
      expect(got).toBe(code);
      expect(first).toMatch(said);
      expect(text()).toBe(before);
    },
  );

  it("takes times as times, and nothing as nothing", async () => {
    await run("set", "phone_notices.quiet_from", "22:00");
    await run("set", "phone_notices.quiet_to", "07:30");
    expect(checked(text()).phone_notices).toMatchObject({
      quiet_from: "22:00",
      quiet_to: "07:30",
    });
    await run("set", "phone_notices.quiet_from", "none");
    expect(checked(text()).phone_notices.quiet_from).toBeNull();
  });

  it("takes lists and a single agent's values as YAML", async () => {
    await run("set", "defaults.run_warnings_minutes", "[20, 5]");
    await run("set", "agents.claude.display_name", "Claude");
    await run("set", "agents.claude.run_hours", "8");

    const config = checked(text());
    expect(config.defaults.run_warnings_minutes).toEqual([20, 5]);
    expect(config.agents.claude?.run_hours).toBe(8);
    expect((await run("set", "agents.nobody.run_hours", "8"))[0]).toBe(1);
  });

  it("takes warning minutes with commas too", async () => {
    await run("set", "defaults.run_warnings_minutes", "15, 5");
    expect(checked(text()).defaults.run_warnings_minutes).toEqual([15, 5]);
    expect(
      (await run("set", "defaults.run_warnings_minutes", "15, x"))[0],
    ).toBe(1);
  });

  it.each<[string, string, string]>([
    ["a shorter silent-turn limit", "defaults.turn_timeout_minutes", "10"],
    ["another port", "server.port", "9123"],
  ])("asks before %s, in a terminal or by --yes", async (_name, key, value) => {
    const before = text();
    deps.ask = async (question) => {
      asked.push(question);
      return "n";
    };
    expect((await run("set", key, value))[0]).toBe(1);
    expect(said.join(" ")).toMatch(/ended at the next look|next restart/);
    expect(text()).toBe(before);
    deps.ask = null;
    expect(await run("set", key, value)).toEqual([
      1,
      expect.any(String),
      "Not changed: this needs your yes in a terminal, or --yes.",
    ]);
    expect(text()).toBe(before);
    expect((await run("set", key, value, "--yes"))[0]).toBe(0);
    expect(valueAt(checked(text()), key)).toBe(Number(value));
  });

  it("asks nothing for a longer silent-turn limit, or the same port", async () => {
    deps.ask = null;
    expect((await run("set", "defaults.turn_timeout_minutes", "60"))[0]).toBe(
      0,
    );
    expect((await run("set", "server.port", "8787"))[0]).toBe(0);
  });

  it("adds a pre-approval only after its question, and removes one without", async () => {
    deps.ask = async (question) => {
      asked.push(question);
      return "n";
    };
    const [code, ...lines] = await run(
      "approve",
      "github.com/a/b",
      "code_push",
    );
    expect(code).toBe(1);
    expect(lines.join(" ")).toContain(
      "agents may send code_push to github.com/a/b without asking you, in every room and in every future request, until you remove it",
    );
    expect(checked(text()).pre_approvals).toEqual([]);
    deps.ask = null;
    expect((await run("approve", "github.com/a/b", "code_push"))[0]).toBe(1);
    expect(
      (await run("approve", "github.com/a/b", "code_push", "--yes"))[0],
    ).toBe(0);
    expect(
      await run("approve", " GitHub.com/a/b ", "CODE_PUSH", "--yes"),
    ).toEqual([0, "It was there already.", expect.any(String)]);
    expect(
      (await run("approve", "github.com/c/d", "code_push", "--yes"))[0],
    ).toBe(0);
    expect((await run("unapprove", "github.com/a/b", "code_push"))[0]).toBe(0);
    expect(checked(text()).pre_approvals).toEqual([
      { recipient: "github.com/c/d", data: "code_push" },
    ]);
    expect((await run("unapprove", "github.com/a/b", "code_push"))[1]).toBe(
      "It wasn't there.",
    );
    // Not as a whole list, which would skip the question.
    expect(
      (await run("set", "pre_approvals", "[{recipient: x, data: y}]"))[0],
    ).toBe(2);
    for (const [recipient, data] of [
      [" ", "x"],
      ["x", "a\nb"],
      ["x".repeat(201), "y"],
    ])
      expect((await run("approve", recipient!, data!, "--yes"))[0]).toBe(1);
    expect(said.join(" ")).toContain("longer than 200 characters");
    await run("approve", " ", "x", "--yes");
    expect(said.join(" ")).toContain("The recipient is empty");
  });

  it("keeps both of two pre-approvals that are added at the same moment", async () => {
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        changeSettings(
          home,
          approvalChange(
            { recipient: `github.com/x/${name}`, data: "code_push" },
            true,
          ),
        ),
      ),
    );
    expect(
      checked(text())
        .pre_approvals.map((one) => one.recipient)
        .sort(),
    ).toEqual(["github.com/x/a", "github.com/x/b", "github.com/x/c"]);
    await Promise.all([
      changeSettings(
        home,
        approvalChange(
          { recipient: "github.com/x/a", data: "code_push" },
          false,
        ),
      ),
      changeSettings(
        home,
        approvalChange(
          { recipient: "github.com/x/d", data: "code_push" },
          true,
        ),
      ),
    ]);
    expect(
      checked(text())
        .pre_approvals.map((one) => one.recipient)
        .sort(),
    ).toEqual(["github.com/x/b", "github.com/x/c", "github.com/x/d"]);
  });

  it("reads a file of an earlier version, and cleans it up only after a yes", async () => {
    const old = `# mine
defaults:
  hours: { start: "09:00", end: "18:00", days: [mon] }
  run_hours: 4
agents:
  claude:
    display_name: Claude
    hours: { start: "10:00", end: "12:00", days: [mon] }
room:
  checkin: 2
ui:
  role_picker: true
`;
    put(old);
    expect(checked(text()).defaults.run_hours).toBe(4);
    expect(unusedKeys(parse(text()))).toEqual([
      "defaults.hours",
      "agents.claude.hours",
      "room",
      "ui",
    ]);
    expect((await run())[0]).toBe(0);
    expect(said.join("\n")).toContain(
      "Not read by this version: defaults.hours, agents.claude.hours, room, ui",
    );
    deps.ask = null;
    expect((await run("clean"))[0]).toBe(1);
    expect(text()).toBe(old);
    expect((await run("clean", "--yes"))[0]).toBe(0);
    expect(parse(text())).toEqual({
      defaults: { run_hours: 4 },
      agents: { claude: { display_name: "Claude" } },
    });
    expect(text()).toContain("# mine");
    expect(await run("clean")).toEqual([0, "Nothing to clean up."]);
    // A key that comes after the question isn't removed along.
    put("ui:\n  x: 1\n");
    deps.ask = async () => {
      put("ui:\n  x: 1\nfuture:\n  y: 2\n");
      return "y";
    };
    expect((await run("clean"))[0]).toBe(1);
    expect(said.join(" ")).toContain("changed meanwhile");
    expect(parse(text())).toEqual({ ui: { x: 1 }, future: { y: 2 } });
    // Only what is unused then: a key in use is never dropped.
    await expect(
      changeSettings(home, { drop: ["defaults.run_hours"] }),
    ).rejects.toThrow("in use");
  });

  it("uses another command only after a yes, in a terminal", async () => {
    const before = text();
    const set = () => run("set", "rejoin.codex_command", "/opt/codex");
    deps.look = async () => ({ ok: false, reason: "it has a link" });
    expect(await set()).toEqual([1, "Not changed: it has a link."]);
    deps.look = async (path) => ({
      ok: true,
      path,
      stamp: "1",
      signed_by: "Someone",
    });
    deps.ask = null;
    expect((await set())[0]).toBe(1);
    deps.ask = async () => "";
    const [code, first] = await set();
    expect([code, text()]).toEqual([1, before]);
    expect(first).toContain("as you");
    expect(first).toContain("not a guarantee");
    deps.ask = async () => "yes";
    expect((await set())[0]).toBe(0);
    expect(
      JSON.parse(readFileSync(join(home, "codex-command.json"), "utf8")),
    ).toEqual({ agreed: { path: "/opt/codex", stamp: "1" } });
    await run("reset", "rejoin.codex_command");
    expect(
      JSON.parse(readFileSync(join(home, "codex-command.json"), "utf8")),
    ).toEqual({ agreed: null });
  });

  it("says what is wrong with a file that can't be used", async () => {
    put("rejoin: {\n");
    expect((await run("get", "rejoin.enabled"))[1]).toMatch(/line/);
    expect((await run("set", "rejoin.enabled", "false"))[0]).toBe(1);
    expect(text()).toBe("rejoin: {\n");
  });
});
