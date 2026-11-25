import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { request } from "node:http";
import { spawnSync } from "node:child_process";

/**
 * Started by an agent in the background, so that its app starts the agent's
 * conversation again when this ends. It says nothing until the lead asks for
 * a rejoin. It starts nothing but `ps`, reads one file and calls only Konfab
 * on this computer. See docs/design/rejoin-claude.md.
 */

const ADDRESS = "127.0.0.1";
const START_MS = 10_000;
const CALL_MS = 40_000;
const REST_MS = 60_000;
const ABOVE_MS = 30_000;
const MAX_ANSWER = 1024;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The whole line in one write, or false: then nothing more is written. */
function say(line: string): boolean {
  const bytes = Buffer.from(`${line}\n`);
  try {
    return writeSync(1, bytes) === bytes.length;
  } catch {
    return false;
  }
}

function end(why: string): never {
  say(`Konfab watcher: ${why}. There is no request; start nothing.`);
  process.exit(1);
}

function readTicket(path: string): { ticket: string; port: number } {
  let file: number;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    end("its ticket isn't there");
  }
  try {
    const info = fstatSync(file);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.nlink !== 1 ||
      info.size > MAX_ANSWER
    )
      end("its ticket isn't private");
    const { ticket, port } = JSON.parse(readFileSync(file, "utf8")) as {
      ticket: unknown;
      port: unknown;
    };
    if (
      typeof ticket !== "string" ||
      !/^kfw_[A-Za-z0-9_-]{22,43}$/.test(ticket) ||
      !Number.isInteger(port) ||
      (port as number) < 1 ||
      (port as number) > 65535
    )
      end("its ticket can't be read");
    return { ticket, port: port as number };
  } catch {
    end("its ticket can't be read");
  } finally {
    closeSync(file);
  }
}

type Answer = { code: number; body: Record<string, unknown> } | null;

/** Null for anything that isn't a short, whole JSON answer. */
function call(
  path: string,
  { ticket, port }: { ticket: string; port: number },
  body: object,
  limit: number,
): Promise<Answer> {
  return new Promise((done) => {
    const text = JSON.stringify(body);
    const sent = request(
      {
        host: ADDRESS,
        port,
        path,
        method: "POST",
        agent: false,
        headers: {
          authorization: `Bearer ${ticket}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
        },
      },
      (response) => {
        let got = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          got += chunk;
          if (got.length > MAX_ANSWER) finish(null);
        });
        response.on("end", () => {
          try {
            const value = JSON.parse(got) as unknown;
            finish(
              typeof value === "object" && value !== null
                ? {
                    code: response.statusCode ?? 0,
                    body: value as Record<string, unknown>,
                  }
                : null,
            );
          } catch {
            finish(null);
          }
        });
        response.on("error", () => finish(null));
      },
    );
    let finished = false;
    const finish = (answer: Answer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sent.destroy();
      done(answer);
    };
    const timer = setTimeout(() => finish(null), limit);
    sent.on("error", () => finish(null));
    sent.end(text);
  });
}

/** Processes above this one, with their start, up to the first of the system. */
function above(): Map<number, string> | null {
  const done = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { LC_ALL: "C", TZ: "UTC" },
  });
  if (done.status !== 0) return null;
  const all = new Map<number, { parent: number; start: string }>();
  for (const line of done.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match)
      all.set(Number(match[1]), {
        parent: Number(match[2]),
        start: match[3]!,
      });
  }
  const chain = new Map<number, string>();
  for (let at = process.pid; at > 1;) {
    const found = all.get(at);
    if (!found || chain.has(at)) return null;
    chain.set(at, found.start);
    at = found.parent;
  }
  return chain;
}

/** Ends with the app: one of the processes above it is gone. */
function endWithTheApp(): void {
  const first = above();
  if (!first) end("it can't see which app started it");
  setInterval(() => {
    const now = above();
    // Not being able to look means nothing.
    if (!now) return;
    for (const [pid, start] of first)
      if (now.get(pid) !== start) process.exit(0);
  }, ABOVE_MS);
}

const path = process.argv[2];
if (!path || process.argv.length !== 3) end("it was started without a ticket");
const ticket = readTicket(path);
endWithTheApp();
const hello = { pid: process.pid };

// At the start it must be accepted at once, or it ends in the same turn.
// The time that counts is the time it was running: a pause of the whole
// process is seen as a jump, and the ticket is gone by then in any case.
let accepted = false;
const from = Date.now();
let wait = 1_000;
for (;;) {
  const answer = await call("/agent/watch", ticket, hello, CALL_MS);
  const status = answer?.code === 200 ? answer.body.status : undefined;
  if (status === "wait") {
    accepted = true;
    wait = 1_000;
    continue;
  }
  if (status === "print") {
    const { request: number, handover } = answer!.body;
    if (
      typeof number !== "string" ||
      !/^[A-HJKMNP-TV-Z0-9]{26}$/.test(number) ||
      typeof handover !== "string"
    )
      end("Konfab's answer can't be read");
    // Once. A write that isn't whole is never made again or confirmed.
    if (!say(`Konfab: the lead asked you to rejoin. request "${number}"`))
      process.exit(3);
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const confirmed = await call(
        "/agent/watch/printed",
        ticket,
        { handover },
        3_000,
      );
      if (confirmed) break;
      await pause(500);
    }
    process.exit(0);
  }
  if (status === "leave") {
    say("Konfab watcher ended; nothing to do.");
    process.exit(0);
  }
  if (status === "rest") {
    accepted = true;
    await pause(REST_MS);
    continue;
  }
  // Konfab is stopped, or doesn't know this ticket any more.
  if (!accepted && (answer || Date.now() - from > START_MS))
    end("Konfab didn't accept it");
  if (answer && answer.code === 401) {
    await pause(REST_MS);
    continue;
  }
  await pause(wait);
  wait = Math.min(wait * 2, 30_000);
}
