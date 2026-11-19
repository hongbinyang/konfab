import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureHome,
  loadConfig,
  parseConfig,
} from "../../src/server/config.js";

describe("defaults on a first run", () => {
  it("needs no config file and no settings", () => {
    const empty = parseConfig("");
    expect(empty.server).toEqual({ port: 8787, tick_seconds: 30 });
    expect(empty.connectors.install).toBe("user");
    expect(empty.multi_agent.max_per_app).toBe(4);
    expect(empty.defaults).toMatchObject({
      run_hours: 5,
      run_warnings_minutes: [30, 10, 5],
      max_consecutive_agent_messages: 50,
      wait_timeout_seconds: 50,
      turn_timeout_minutes: 30,
      auto_continue_delay_seconds: 180,
      max_message_chars: 20000,
      max_decision_chars: 4000,
      max_attachment_mb: 10,
    });
  });

  it("writes the default config into an empty home, and the written file gives the same settings plus both agents", () => {
    const home = join(mkdtempSync(join(tmpdir(), "konfab-defaults-")), "home");
    try {
      ensureHome(home);
      const written = loadConfig(home);
      expect(written.server.port).toBe(8787);
      expect(Object.keys(written.agents).sort()).toEqual(["claude", "codex"]);
      expect(written.defaults).toEqual({
        ...parseConfig("").defaults,
        ...written.defaults,
      });
      // A second run leaves an existing file alone.
      const before = readFileSync(join(home, "config.yaml"), "utf8");
      ensureHome(home);
      expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(before);
    } finally {
      rmSync(join(home, ".."), { recursive: true, force: true });
    }
  });
});
