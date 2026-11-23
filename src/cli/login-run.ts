import { spawn } from "node:child_process";
import { constants } from "node:os";
import { resolve } from "node:path";
import { konfabHome } from "../server/config.js";
import { LogFile, OUTPUT_NAME, logDirectory } from "../server/log-file.js";

/**
 * What the login item starts. Runs the server and keeps everything it prints,
 * such as a crash, in a log that stays small all the time: macOS itself would
 * let that file grow without a limit. Ends as the server ends, so macOS
 * restarts it only after a crash.
 */
const output = new LogFile(logDirectory(konfabHome()), {
  name: OUTPUT_NAME,
  maxBytes: 1024 * 1024,
  keep: 1,
  // There is nowhere else to say it.
  warn: () => undefined,
});

const server = spawn(
  process.execPath,
  [resolve(import.meta.dirname, "../server/index.js")],
  { stdio: ["ignore", "pipe", "pipe"] },
);
for (const stream of [server.stdout, server.stderr])
  stream.on("data", (chunk: Buffer) => {
    // In parts, so that one huge line is kept within the limit too.
    for (let at = 0; at < chunk.length; at += 32 * 1024)
      output.write(chunk.subarray(at, at + 32 * 1024));
  });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () =>
    server.kill(signal === "SIGHUP" ? "SIGTERM" : signal),
  );
server.once("error", (error) => {
  output.write(`Konfab couldn't start: ${error.message}\n`);
  process.exitCode = 1;
});
// After everything it printed has been read.
server.once("close", (code, signal) => {
  if (code !== 0)
    output.write(
      `${new Date().toISOString()} Konfab stopped (${signal ?? `exit code ${code}`})\n`,
    );
  output.destroy();
  process.exit(code ?? 128 + (signal ? constants.signals[signal] : 1));
});
