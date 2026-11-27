import { spawnSync } from "node:child_process";
import type { RequestListener } from "node:http";
import { describe, expect, it } from "vitest";
import { below, ended, pause, standIn } from "./watch-helpers.js";

/**
 * The watcher's own timers are real: 10 seconds for an answer at its start,
 * 30 seconds between looks at the processes above it. Each test has its own
 * stand-in, so that they wait at the same time.
 */
describe
  .runIf(process.platform === "darwin")
  .concurrent("the watcher command's real waits", () => {
    it.each([
      ["nobody there", (konfab) => void konfab.server.close()],
      [
        "endless",
        (konfab) =>
          void (konfab.state.answer = (_request, response) => {
            response.writeHead(200);
            const timer = setInterval(() => response.write("x".repeat(500)), 5);
            response.on("close", () => clearInterval(timer));
          }),
      ],
      [
        "broken off",
        (konfab) =>
          void (konfab.state.answer = (_request, response) =>
            void response.destroy()),
      ],
      [
        "not JSON",
        (konfab) =>
          void (konfab.state.answer = (_request, response) =>
            void response.end("<html>")),
      ],
    ] as [
      string,
      (konfab: {
        server: { close: () => void };
        state: { answer: RequestListener };
      }) => void,
    ][])(
      "ends after ten seconds when there is no answer at its start: %s",
      async (_name, prepare) => {
        const konfab = await standIn();
        try {
          prepare(konfab);
          const started = konfab.watch();
          expect(await ended(started, 3000)).toBe("running");
          expect(await ended(started, 25_000)).toBe(1);
          expect(started.out()).toContain("didn't accept it");
        } finally {
          await konfab.close();
        }
      },
      40_000,
    );

    it("ends silently when a process above it is gone", async () => {
      const konfab = await standIn();
      try {
        const started = konfab.watch();
        await pause(1500);
        expect(konfab.calls).toHaveLength(1);
        const inner = below(started.child.pid!);
        expect(inner).toBeGreaterThan(1);
        started.child.kill("SIGKILL");
        const there = () =>
          spawnSync("/bin/ps", ["-o", "pid=", "-p", String(inner)], {
            encoding: "utf8",
          }).stdout.trim() !== "";
        expect(there()).toBe(true);
        await expect
          .poll(there, { timeout: 45_000, interval: 1000 })
          .toBe(false);
        expect(started.out()).toBe("");
      } finally {
        await konfab.close();
      }
    }, 60_000);
  });
