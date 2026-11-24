import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  conversationId,
  rejoinMessage,
  type SendResult,
} from "../domain/rejoin.js";

/** The ChatGPT app's own copy on macOS. Never a search through PATH. */
export const APP_COMMAND =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
export const APP_REQUIREMENT =
  '=identifier "codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"';
/** Versions this was tried with. Any other is off unless allowed. */
export const TESTED_VERSIONS = ["0.171"];

const CHECK_MS = 5_000;
const SEND_MS = 15_000;
const MAX_OUTPUT = 64 * 1024;
const ADMIN_GROUP = 80;

export type CommandOptions = {
  enabled: boolean;
  /** Absolute, from config.yaml; null for the app's own copy. */
  command: string | null;
  allowUntested: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  uid?: number;
  /** Test seam: what starts a process. */
  run?: typeof runCommand;
};

export type Checked =
  | { ok: true; path: string; version: string; tested: boolean; stamp: string }
  /** `off`: by choice or on this system; there is nothing to look into. */
  | { ok: false; reason: string; off: boolean };

export type RunResult = {
  started: boolean;
  code: number | null;
  /** False after a time limit, a signal or too much output. */
  complete: boolean;
  stdout: string;
  stderr: string;
};

const stampOf = (info: Stats): string =>
  [info.dev, info.ino, info.size, info.mtimeMs, info.mode, info.uid].join(":");

/**
 * Runs without a shell, input or more environment than it needs. The app's
 * command writes to its own folder even for its version, so a check (no `env`)
 * gets a folder that is removed afterwards; only sending uses the user's.
 */
export function runCommand(
  path: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  const directory = mkdtempSync(join(tmpdir(), "konfab-rejoin-"));
  const remove = () => {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Something still writes there; a temporary folder is left behind.
    }
  };
  const start = () =>
    spawn(path, args, {
      cwd: directory,
      shell: false,
      // Its own group, so that a time limit ends whatever it started too.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        ...(env
          ? {
              HOME: env.HOME ?? homedir(),
              ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
            }
          : { HOME: directory, CODEX_HOME: directory }),
      },
    });
  return new Promise<RunResult>((done, fail) => {
    let complete = true;
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      remove();
      done({ started, code, complete, stdout, stderr });
    };
    let child: ReturnType<typeof start>;
    try {
      child = start();
    } catch (error) {
      remove();
      fail(error as Error);
      return;
    }
    // A process was made, even if nothing has been heard of it yet.
    const started = child.pid !== undefined;
    const stop = () => {
      complete = false;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      // Something that left the group may still hold its output open.
      finish(null);
    };
    const timer = setTimeout(stop, timeoutMs);
    const collect = (chunk: Buffer, stream: "out" | "err") => {
      if (finished) return;
      if (stream === "out") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > MAX_OUTPUT) stop();
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "out"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "err"));
    child.once("error", () => {
      if (!started) finish(null);
      else complete = false;
    });
    child.once("close", (code, signal) => {
      if (signal) complete = false;
      finish(code);
    });
  });
}

/** The file and every folder above it can be changed only by this user or the system. */
function ownershipProblem(
  path: string,
  uid: number,
  platform: NodeJS.Platform,
): string | null {
  for (let at = path; ; at = dirname(at)) {
    const info = lstatSync(at);
    if (info.isSymbolicLink()) return "its path has a link";
    if (info.uid !== 0 && info.uid !== uid)
      return "it or a folder above it belongs to someone else";
    if (info.mode & 0o002)
      return "it or a folder above it can be changed by anyone";
    if (
      info.mode & 0o020 &&
      !(platform === "darwin" && info.gid === ADMIN_GROUP && info.uid === 0)
    )
      return "it or a folder above it can be changed by a group";
    if (dirname(at) === at) return null;
  }
}

/** Whether a command that may be used is there. Uses no allowance. */
export async function checkCommand(options: CommandOptions): Promise<Checked> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const run: typeof runCommand = async (...args) => {
    try {
      return await (options.run ?? runCommand)(...args);
    } catch {
      return {
        started: false,
        code: null,
        complete: false,
        stdout: "",
        stderr: "",
      };
    }
  };
  const no = (reason: string, off = false): Checked => ({
    ok: false,
    reason,
    off,
  });
  if (!options.enabled) return no("it is turned off (rejoin.enabled)", true);
  // An isolated run uses nothing of the user's.
  if (env.KONFAB_ISOLATED === "1") return no("this is an isolated run", true);
  if (platform !== "darwin") return no("it has only been tried on macOS", true);
  if (options.command !== null && !isAbsolute(options.command))
    return no("rejoin.codex_command isn't an absolute path");
  let path: string;
  let stamp: string;
  try {
    path = realpathSync(options.command ?? APP_COMMAND);
    const info = statSync(path);
    if (!info.isFile()) return no("the command isn't a file");
    accessSync(path, constants.X_OK);
    const problem = ownershipProblem(path, uid, platform);
    if (problem) return no(problem);
    stamp = stampOf(info);
  } catch {
    return no(
      options.command
        ? "rejoin.codex_command can't be found or run"
        : "the Codex app's command isn't there",
    );
  }
  if (options.command === null) {
    const signed = await run(
      "/usr/bin/codesign",
      ["--verify", "--strict", "-R", APP_REQUIREMENT, path],
      CHECK_MS,
    );
    if (!signed.complete || signed.code !== 0)
      return no("the Codex app's command isn't signed as expected");
  }
  const version = await run(path, ["--version"], CHECK_MS);
  const number = /^codex-cli (\d+\.\d+)\.\S+\s*$/.exec(version.stdout)?.[1];
  if (!version.complete || version.code !== 0 || !number)
    return no("its version can't be read");
  const tested = TESTED_VERSIONS.includes(number);
  if (!tested && !options.allowUntested)
    return no(
      `Codex ${number} hasn't been tried; set rejoin.allow_untested_version to use it anyway`,
    );
  const help = await run(path, ["queue", "--help"], CHECK_MS);
  if (
    !help.complete ||
    help.code !== 0 ||
    !/(^|\s)--thread\b/.test(help.stdout) ||
    !/(^|\s)--message\b/.test(help.stdout)
  )
    return no("it can't queue messages");
  return { ok: true, path, version: number, tested, stamp };
}

/**
 * Only a known refusal that names this conversation, or no process at all,
 * means that nothing was queued. Whatever else isn't clear is "unsure".
 */
export function classify(result: RunResult, conversation: string): SendResult {
  if (!result.started) return "refused";
  if (!result.complete) return "unsure";
  const taken = result.stdout
    .split("\n")
    .some((line) =>
      new RegExp(
        `^Queued message [0-9a-f-]{36} for thread ${conversation}\\.$`,
      ).test(line.trim()),
    );
  const refused =
    result.stderr.includes(`no rollout found for thread id ${conversation} `) ||
    result.stderr.includes(
      `No active session found matching '${conversation}'.`,
    );
  if (result.code === 0 && taken && !refused) return "taken";
  if (result.code === 1 && refused && !taken) return "refused";
  return "unsure";
}

/** Sends once. Its output is matched and dropped. */
export async function sendRejoin(
  options: CommandOptions,
  conversation: string,
  number: string,
): Promise<SendResult> {
  // It goes into an argument and a pattern.
  if (conversationId(conversation) === null) return "refused";
  const checked = await checkCommand(options);
  if (!checked.ok) return "refused";
  try {
    // Replaced since the checks: nothing is started.
    if (stampOf(statSync(checked.path)) !== checked.stamp) return "refused";
  } catch {
    return "refused";
  }
  try {
    return classify(
      await (options.run ?? runCommand)(
        checked.path,
        [
          "queue",
          `--thread=${conversation}`,
          `--message=${rejoinMessage(number)}`,
        ],
        SEND_MS,
        options.env ?? process.env,
      ),
      conversation,
    );
  } catch {
    // The command may have been started.
    return "unsure";
  }
}
