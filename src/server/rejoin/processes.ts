import { spawnSync } from "node:child_process";

/**
 * What can be said about a process, without sending it anything. "unknown"
 * whenever it isn't clear: nothing is concluded from that.
 */
export type Looked =
  | { state: "there"; uid: number; start: string; command: string }
  | "none"
  | "unknown";

export type Processes = {
  look: (pid: number) => Looked;
  /** Another value after each start of the computer; null when unknown. */
  boot: () => string | null;
};

const LIMIT_MS = 2_000;
const LINE =
  /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+?)\s*$/;

export type Run = (
  path: string,
  args: string[],
) => { code: number | null; out: string; err: string };

/** Start times in one language and zone, so that they can be compared. */
const run: Run = (path, args) => {
  const done = spawnSync(path, args, {
    encoding: "utf8",
    timeout: LIMIT_MS,
    maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  if (done.error || done.signal) return { code: null, out: "", err: "failed" };
  return { code: done.status, out: done.stdout, err: done.stderr };
};

export function macProcesses(start: Run = run): Processes {
  return {
    look(pid) {
      if (!Number.isSafeInteger(pid) || pid < 2) return "unknown";
      const { code, out, err } = start("/bin/ps", [
        "-ww",
        "-o",
        "pid=,uid=,lstart=,command=",
        "-p",
        String(pid),
      ]);
      if (code === 1 && out === "" && err === "") return "none";
      if (code !== 0 || err !== "") return "unknown";
      const lines = out.split("\n").filter((line) => line.trim());
      const match = lines.length === 1 ? LINE.exec(lines[0]!) : null;
      if (!match || Number(match[1]) !== pid) return "unknown";
      return {
        state: "there",
        uid: Number(match[2]),
        start: match[3]!.replace(/\s+/g, " "),
        command: match[4]!,
      };
    },
    boot() {
      // Not the start time, which moves when the clock is set.
      const { code, out, err } = start("/usr/sbin/sysctl", [
        "-n",
        "kern.bootsessionuuid",
      ]);
      const value = out.trim();
      return code === 0 && err === "" && /^[0-9A-F-]{36}$/i.test(value)
        ? value
        : null;
    },
  };
}
