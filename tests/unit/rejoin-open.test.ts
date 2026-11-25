import { describe, expect, it, vi } from "vitest";
import { canOpen, openApp, type App } from "../../src/server/rejoin/open.js";
import type { RunResult } from "../../src/server/rejoin/codex.js";

const ok: RunResult = {
  started: true,
  code: 0,
  complete: true,
  stdout: "",
  stderr: "",
};
const options = (run: () => Promise<RunResult> = async () => ok) => ({
  platform: "darwin" as const,
  isApp: () => true,
  env: { HOME: "/Users/lead" },
  run: vi.fn(run),
});

describe("bringing an app to the front", () => {
  it.each([
    ["codex", "/Applications/ChatGPT.app"],
    ["claude", "/Applications/Claude.app"],
  ] as [App, string][])("runs one fixed command for %s", async (app, path) => {
    const given = options();
    expect(await openApp(app, given)).toBe(true);
    expect(given.run.mock.calls).toEqual([
      ["/usr/bin/open", ["-a", path], 5_000, { HOME: "/Users/lead" }],
    ]);
  });

  it.each([
    ["a failing command", async () => ({ ...ok, code: 1 })],
    ["one that hangs", async () => ({ ...ok, code: null, complete: false })],
    ["one that didn't start", async () => ({ ...ok, started: false })],
    ["one that throws", () => Promise.reject(new Error("no"))],
  ])("says that it didn't work: %s", async (_what, run) => {
    expect(await openApp("claude", options(run))).toBe(false);
  });

  it("runs nothing without the app or on another system", async () => {
    for (const other of [
      { ...options(), isApp: () => false },
      { ...options(), platform: "linux" as const },
    ]) {
      expect(canOpen("codex", other)).toBe(false);
      expect(await openApp("codex", other)).toBe(false);
      expect(other.run).not.toHaveBeenCalled();
    }
  });
});
