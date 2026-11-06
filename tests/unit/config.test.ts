import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/server/config.js";

describe("parseConfig", () => {
  it("uses the agreed defaults for an empty file", () => {
    const config = parseConfig("");
    expect(config.server.port).toBe(8787);
    expect(config.defaults.hours.start).toBe("09:00");
    expect(config.defaults.hours.end).toBe("18:00");
    expect(config.defaults.hours.days).toHaveLength(7);
    expect(config.defaults.max_consecutive_agent_messages).toBe(5);
    expect(Object.keys(config.agents)).toEqual(["claude", "codex"]);
    expect(config.pre_approvals).toEqual([]);
  });

  it("keeps other defaults when only some values are set", () => {
    const config = parseConfig("defaults:\n  wait_timeout_seconds: 300\n");
    expect(config.defaults.wait_timeout_seconds).toBe(300);
    expect(config.defaults.max_message_chars).toBe(20000);
  });

  it("reads agent hours and pre-approvals", () => {
    const config = parseConfig(`
agents:
  claude:
    display_name: Claude
    hours: { start: "10:00", end: "12:00", days: [mon] }
pre_approvals:
  - recipient: github.com/me/repo
    data: code_push
`);
    expect(config.agents.claude?.hours?.start).toBe("10:00");
    expect(config.pre_approvals[0]?.data).toBe("code_push");
  });

  it("rejects invalid values", () => {
    expect(() => parseConfig("server:\n  port: 80\n")).toThrow();
    expect(() =>
      parseConfig(
        'defaults:\n  hours: { start: "9am", end: "18:00", days: [mon] }\n',
      ),
    ).toThrow();
    expect(() =>
      parseConfig(
        'defaults:\n  hours: { start: "09:00", end: "18:00", days: [] }\n',
      ),
    ).toThrow();
  });
});
