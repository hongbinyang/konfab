import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
export const SCRIPT = join(ROOT, "dist/cli/watch.js");
export const TICKET = `kfw_${"a".repeat(27)}`;
export const pause = (ms: number) =>
  new Promise((done) => setTimeout(done, ms));

export type Started = {
  child: ChildProcess;
  out: () => string;
  ended: Promise<number | null>;
};

/** As an app starts a background command: by a shell that stays above it. */
export const startCommand = (
  command: string,
  running: ChildProcess[],
): Started => {
  const child = spawn("/bin/sh", ["-c", `${command}; exit $?`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  let out = "";
  child.stdout!.on("data", (chunk) => (out += chunk));
  child.stderr!.on("data", (chunk) => (out += chunk));
  return {
    child,
    out: () => out,
    ended: new Promise((done) => child.once("close", (code) => done(code))),
  };
};

export const below = (pid: number): number =>
  Number(
    spawnSync("/usr/bin/pgrep", ["-P", String(pid)], {
      encoding: "utf8",
    }).stdout.trim(),
  );

export const ended = async (started: Started, ms: number) =>
  Promise.race([started.ended, pause(ms).then(() => "running" as const)]);

/** Ends each shell and the watcher below it. */
export const killAll = (running: ChildProcess[]) => {
  for (const child of running.splice(0)) {
    const inner = child.pid ? below(child.pid) : 0;
    if (inner) spawnSync("/bin/kill", ["-9", String(inner)]);
    child.kill("SIGKILL");
  }
};

export const json =
  (value: unknown, code = 200): RequestListener =>
  (_request, response) => {
    response.writeHead(code, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };

/**
 * A stand-in Konfab of its own, with its own folder, so that tests that wait
 * for the watcher's real timers can run at the same time.
 */
export async function standIn() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "konfab-watch-")));
  const running: ChildProcess[] = [];
  const calls: { path: string; body: string; ticket: string }[] = [];
  const state: { answer: RequestListener } = { answer: () => {} };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      calls.push({
        path: request.url ?? "",
        body,
        ticket: request.headers.authorization ?? "",
      });
      state.answer(request, response);
    });
  });
  await new Promise<void>((done) =>
    server.listen(0, "127.0.0.1", () => done()),
  );
  const port = (server.address() as AddressInfo).port;
  const ticketFile = () => {
    const path = join(root, "7");
    writeFileSync(path, JSON.stringify({ ticket: TICKET, port }), {
      mode: 0o600,
    });
    return path;
  };
  return {
    server,
    calls,
    state,
    watch: () =>
      startCommand(
        `'${process.execPath}' '${SCRIPT}' '${ticketFile()}'`,
        running,
      ),
    close: async () => {
      killAll(running);
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
