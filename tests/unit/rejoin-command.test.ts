import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newNumber, rejoinMessage } from "../../src/server/domain/rejoin.js";
import {
  checkCommand,
  classify,
  runCommand,
  sendRejoin,
  type CommandOptions,
  type RunResult,
} from "../../src/server/rejoin/codex.js";

const HERE = "019a0000-0000-7000-8000-000000000001";
const OTHER = "019a0000-0000-7000-8000-000000000002";
const QUEUED = `Queued message 11111111-2222-7333-8444-555555555555 for thread ${HERE}.`;
const NO_ROLLOUT = `Error: no rollout found for thread id ${HERE} (code -32600)`;
const NO_SESSION = `Error: No active session found matching '${HERE}'.`;

const result = (overrides: Partial<RunResult>): RunResult => ({
  started: true,
  code: 0,
  complete: true,
  stdout: "",
  stderr: "",
  ...overrides,
});

describe("what the command's result means", () => {
  it.each([
    ["taken", { stdout: `${QUEUED}\n` }, "taken"],
    [
      "taken, with other lines",
      { stdout: `hello\n${QUEUED}\r\nbye\n` },
      "taken",
    ],
    ["refused", { code: 1, stderr: NO_ROLLOUT }, "refused"],
    ["refused, no session", { code: 1, stderr: NO_SESSION }, "refused"],
    ["never started", { started: false, code: null }, "refused"],
    ["another conversation", { stdout: QUEUED.replace(HERE, OTHER) }, "unsure"],
    ["a longer number", { stdout: QUEUED.replace(HERE, `${HERE}0`) }, "unsure"],
    ["part of a line", { stdout: `Not: ${QUEUED}` }, "unsure"],
    ["both texts, 0", { stdout: QUEUED, stderr: NO_ROLLOUT }, "unsure"],
    [
      "both texts, 1",
      { code: 1, stdout: QUEUED, stderr: NO_ROLLOUT },
      "unsure",
    ],
    ["refusal with 0", { stderr: NO_ROLLOUT }, "unsure"],
    ["success with 1", { code: 1, stdout: QUEUED }, "unsure"],
    [
      "refusal of another conversation",
      { code: 1, stderr: NO_ROLLOUT.replace(HERE, OTHER) },
      "unsure",
    ],
    ["refusal with 2", { code: 2, stderr: NO_ROLLOUT }, "unsure"],
    ["refusal in stdout", { code: 1, stdout: NO_ROLLOUT }, "unsure"],
    ["success in stderr", { stderr: QUEUED }, "unsure"],
    ["nothing", {}, "unsure"],
    ["another error", { code: 1, stderr: "Error: not signed in" }, "unsure"],
    ["cut off after success", { stdout: QUEUED, complete: false }, "unsure"],
    [
      "cut off after refusal",
      { code: 1, stderr: NO_ROLLOUT, complete: false },
      "unsure",
    ],
    ["a signal", { code: null, complete: false }, "unsure"],
  ] as [string, Partial<RunResult>, string][])("%s", (_name, part, meaning) => {
    expect(classify(result(part), HERE)).toBe(meaning);
  });
});

// The stand-ins are shell scripts, and only macOS is offered.
describe.runIf(process.platform === "darwin")("the command", () => {
  let root: string;
  let command: string;
  let calls: string;

  /** Stands in for the app's command; `queue` is the body for a real send. */
  const standIn = (
    queue: string,
    version = "codex-cli 0.171.0-alpha.13",
    help = "--thread <ID> --message <TEXT>",
  ) => {
    writeFileSync(
      command,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi
if [ "$2" = "--help" ]; then echo "${help}"; exit 0; fi
printf '%s\\0' "$#" "$@" >> "${calls}"
${queue}
`,
      { mode: 0o755 },
    );
    chmodSync(command, 0o755);
  };
  const options = (
    overrides: Partial<CommandOptions> = {},
  ): CommandOptions => ({
    enabled: true,
    command,
    allowUntested: false,
    env: { HOME: root },
    ...overrides,
  });
  const sends = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  const reason = async (overrides: Partial<CommandOptions> = {}) => {
    const checked = await checkCommand(options(overrides));
    return checked.ok ? "ok" : checked.reason;
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "konfab-command-")));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    command = join(root, "a", "b", "codex");
    calls = join(root, "calls");
    standIn(`echo "${QUEUED}"`);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("sends the fixed prompt once, as single arguments and byte for byte", async () => {
    const number = newNumber();
    expect(await sendRejoin(options(), HERE, number)).toBe("taken");
    expect(sends().split("\0")).toEqual([
      "3",
      "queue",
      `--thread=${HERE}`,
      `--message=${rejoinMessage(number)}`,
      "",
    ]);
  });

  it("gives it no input, no folder of ours and only the environment it needs", async () => {
    process.env.KONFAB_TEST_SECRET = "secret";
    try {
      standIn(
        `env > "${root}/env"; pwd > "${root}/pwd"; ls -A > "${root}/ls"; cat > "${root}/in"; echo "${QUEUED}"`,
      );
      expect(
        await sendRejoin(
          options({ env: { HOME: root, CODEX_HOME: "/x", SECRET: "y" } }),
          HERE,
          newNumber(),
        ),
      ).toBe("taken");
    } finally {
      delete process.env.KONFAB_TEST_SECRET;
    }
    const names = readFileSync(join(root, "env"), "utf8")
      .split("\n")
      .map((line) => line.split("=")[0])
      // Set by the shell itself.
      .filter(
        (name) =>
          name &&
          !["PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"].includes(
            name!,
          ),
      );
    expect(names.sort()).toEqual(["CODEX_HOME", "HOME", "PATH"]);
    expect(readFileSync(join(root, "ls"), "utf8")).toBe("");
    expect(readFileSync(join(root, "in"), "utf8")).toBe("");
    expect(existsSync(readFileSync(join(root, "pwd"), "utf8").trim())).toBe(
      false,
    );
  });

  it("checks it in a folder of its own, so that nothing of the user's changes", async () => {
    writeFileSync(
      command,
      `#!/bin/sh
echo x > "$CODEX_HOME/wrote"; echo "$HOME $CODEX_HOME" >> "${root}/homes"
if [ "$1" = "--version" ]; then echo "codex-cli 0.171.0"; exit 0; fi
echo "--thread --message"
`,
      { mode: 0o755 },
    );
    const mine = join(root, "mine");
    mkdirSync(mine);
    expect(await reason({ env: { HOME: mine, CODEX_HOME: mine } })).toBe("ok");
    expect(readdirSync(mine)).toEqual([]);
    const homes = readFileSync(join(root, "homes"), "utf8").trim().split(/\s+/);
    expect(homes).toHaveLength(4);
    for (const home of homes) {
      expect(home).not.toBe(mine);
      expect(existsSync(home)).toBe(false);
    }
  });

  it.each([
    ["refused", `echo "${NO_ROLLOUT}" >&2; exit 1`, "refused"],
    ["another error", "echo no >&2; exit 1", "unsure"],
    ["killed", "kill -9 $$", "unsure"],
    [
      "endless output",
      "while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done",
      "unsure",
    ],
    [
      "endless errors",
      "while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx >&2; done",
      "unsure",
    ],
  ])("sends at most once: %s", async (_name, queue, meaning) => {
    standIn(queue);
    expect(await sendRejoin(options(), HERE, newNumber())).toBe(meaning);
    expect(
      sends()
        .split("\0")
        .filter((part) => part === "queue"),
    ).toHaveLength(1);
  });

  it("ends a hanging command and whatever it started, and leaves no folder behind", async () => {
    standIn(
      `(sleep 30; echo late > "${root}/late") & echo $! > "${root}/child"; sleep 30`,
    );
    const folders = () =>
      readdirSync(tmpdir()).filter((name) => name.startsWith("konfab-rejoin-"));
    const before = folders();
    const started = Date.now();
    const run = await runCommand(command, ["queue", "x"], 500, { HOME: root });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run).toMatchObject({ started: true, code: null, complete: false });
    expect(classify(run, HERE)).toBe("unsure");
    expect(folders().filter((name) => !before.includes(name))).toEqual([]);
    const child = Number(readFileSync(join(root, "child"), "utf8"));
    await expect
      .poll(() => {
        try {
          return process.kill(child, 0);
        } catch {
          return false;
        }
      })
      .toBe(false);
  });

  it("doesn't wait for something that keeps its output open", async () => {
    standIn(`perl -e 'setpgrp(0,0); sleep 20' & exec sleep 20`);
    const started = Date.now();
    const run = await runCommand(command, ["queue", "x"], 1000, { HOME: root });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run.complete).toBe(false);
  });

  it("reports a command that never became a process", async () => {
    const run = await runCommand(join(root, "none"), [], 1000, { HOME: root });
    expect(run.started).toBe(false);
    expect(classify(run, HERE)).toBe("refused");
  });

  it("counts a failure of unknown kind after starting as unsure", async () => {
    let ran = 0;
    expect(
      await sendRejoin(
        options({
          run: async (path, args, ms, env) => {
            if (args[0] === "queue" && args[1] !== "--help") {
              ran += 1;
              throw new Error("?");
            }
            return runCommand(path, args, ms, env);
          },
        }),
        HERE,
        newNumber(),
      ),
    ).toBe("unsure");
    expect(ran).toBe(1);
  });

  it("starts nothing when it was replaced after the checks", async () => {
    const run: typeof runCommand = async (path, args, ms, env) => {
      const done = await runCommand(path, args, ms, env);
      if (args[1] === "--help") {
        rmSync(command);
        standIn(`echo "${QUEUED}"; # another`);
      }
      return done;
    };
    expect(await sendRejoin(options({ run }), HERE, newNumber())).toBe(
      "refused",
    );
    const gone: typeof runCommand = async (path, args, ms, env) => {
      const done = await runCommand(path, args, ms, env);
      if (args[1] === "--help") rmSync(command);
      return done;
    };
    expect(await sendRejoin(options({ run: gone }), HERE, newNumber())).toBe(
      "refused",
    );
    expect(sends()).toBe("");
  });

  it("starts nothing for a conversation that isn't a full number", async () => {
    for (const odd of ["", "name", "--help", HERE.toUpperCase(), `${HERE}\n`])
      expect(await sendRejoin(options(), odd, newNumber())).toBe("refused");
    expect(sends()).toBe("");
  });

  it.each([
    ["file", "a/b/codex", 0o757],
    ["file, group", "a/b/codex", 0o775],
    ["folder", "a/b", 0o757],
    ["folder above, group", "a", 0o775],
    ["folder above that", ".", 0o777],
  ])("refuses what others can change: %s", async (_name, path, mode) => {
    expect(await reason()).toBe("ok");
    chmodSync(join(root, path), mode);
    expect(await reason()).toMatch(/can be changed by/);
    expect(await sendRejoin(options(), HERE, newNumber())).toBe("refused");
    expect(sends()).toBe("");
  });

  it("refuses what belongs to someone else", async () => {
    expect(await reason({ uid: 12345 })).toMatch(/belongs to someone else/);
  });

  it("follows links first, and checks where they lead", async () => {
    const link = join(root, "link");
    symlinkSync(command, link);
    expect(await reason({ command: link })).toBe("ok");
    symlinkSync(join(root, "a"), join(root, "c"));
    expect(await reason({ command: join(root, "c", "b", "codex") })).toBe("ok");
    chmodSync(join(root, "a", "b"), 0o777);
    expect(await reason({ command: link })).toMatch(/can be changed by anyone/);
    expect(await reason({ command: join(root, "c", "b", "codex") })).toMatch(
      /can be changed by anyone/,
    );
  });

  it("refuses what isn't there, isn't a file or can't be run", async () => {
    expect(await reason({ command: join(root, "none") })).toMatch(
      /can't be found or run/,
    );
    expect(await reason({ command: root })).toMatch(/isn't a file/);
    expect(await reason({ command: "codex" })).toMatch(/absolute/);
    chmodSync(command, 0o644);
    expect(await reason()).toMatch(/can't be found or run/);
  });

  it("offers only versions that were tried, unless the lead allows others", async () => {
    for (const version of [
      "codex-cli 0.172.0",
      "codex-cli 1.171.0",
      "codex-cli 0.1710.0",
    ]) {
      standIn("exit 0", version);
      expect(await reason()).toMatch(/hasn't been tried/);
      expect(
        await checkCommand(options({ allowUntested: true })),
      ).toMatchObject({ ok: true, tested: false });
    }
    for (const version of ["", "0.171.0", "other 0.171.0", "codex-cli x"]) {
      standIn("exit 0", version);
      expect(await reason({ allowUntested: true })).toMatch(
        /version can't be read/,
      );
    }
    standIn("exit 0");
    expect(await checkCommand(options())).toMatchObject({
      ok: true,
      tested: true,
      version: "0.171",
    });
  });

  it("needs both options", async () => {
    for (const help of ["", "--thread", "--message", "--threads --messages"]) {
      standIn("exit 0", "codex-cli 0.171.0", help);
      expect(await reason()).toBe("it can't queue messages");
    }
  });

  it("is off when turned off, isolated or not on macOS, without running anything", async () => {
    const run = async () => {
      throw new Error("ran");
    };
    expect(await reason({ enabled: false, run })).toMatch(/turned off/);
    expect(await reason({ env: { KONFAB_ISOLATED: "1" }, run })).toMatch(
      /isolated/,
    );
    expect(await reason({ platform: "linux", run })).toMatch(/macOS/);
    expect(await reason({ run })).toMatch(/version can't be read/);
  });

  it("needs the expected signature for the app's own copy only", async () => {
    const programs: string[] = [];
    const run: typeof runCommand = async (path, args) => {
      programs.push(path);
      return result({
        code: path === "/usr/bin/codesign" ? 1 : 0,
        stdout:
          args[0] === "--version" ? "codex-cli 0.171.0" : "--thread --message",
      });
    };
    expect(await reason({ run })).toBe("ok");
    expect(programs).not.toContain("/usr/bin/codesign");
    // Without the app on this computer there is nothing to check.
    expect(await reason({ command: null, run })).toMatch(
      /isn't signed as expected|isn't there/,
    );
  });

  it("finds a wrong signature with the real check", async () => {
    const { APP_REQUIREMENT } =
      await import("../../src/server/rejoin/codex.js");
    const check = (path: string) =>
      runCommand(
        "/usr/bin/codesign",
        ["--verify", "--strict", "-R", APP_REQUIREMENT, path],
        5000,
        {},
      );
    // Apple's own program has a valid signature, but isn't this one.
    expect((await check("/bin/ls")).code).not.toBe(0);
    expect((await check(command)).code).not.toBe(0);
  });
});
