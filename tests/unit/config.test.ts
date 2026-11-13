import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/server/config.js";

it("accepts small and fractional run warning thresholds", () => {
  expect(
    parseConfig("defaults:\n  run_warnings_minutes: [5, 3, 0.5]\n").defaults
      .run_warnings_minutes,
  ).toEqual([5, 3, 0.5]);
});

it("still loads config files that set settings removed in later versions", () => {
  const config = parseConfig(
    "ui:\n  role_picker: false\ndefaults:\n  source_cache_mb: 900\n  run_hours: 3\n",
  );
  expect(config.defaults.run_hours).toBe(3);
  expect("source_cache_mb" in config.defaults).toBe(false);
  expect("ui" in config).toBe(false);
});

describe("parseConfig", () => {
  it("validates the default working check-in interval", () => {
    expect(parseConfig("").defaults.checkin_minutes).toBe(2);
    for (const minutes of [1, 2, 5, 10])
      expect(
        parseConfig(`defaults:\n  checkin_minutes: ${minutes}\n`).defaults
          .checkin_minutes,
      ).toBe(minutes);
    for (const minutes of [0, 3, 11])
      expect(() =>
        parseConfig(`defaults:\n  checkin_minutes: ${minutes}\n`),
      ).toThrow();
  });

  it("uses the agreed defaults for an empty file", () => {
    const config = parseConfig("");
    expect(config.server.port).toBe(8787);
    expect(config.defaults.run_hours).toBe(5);
    expect(config.defaults.max_consecutive_agent_messages).toBe(50);
    expect(Object.keys(config.agents)).toEqual(["claude", "codex"]);
    expect(config.pre_approvals).toEqual([]);
  });

  it("allows fractional run windows and per-agent overrides", () => {
    const config = parseConfig(
      "defaults:\n  run_hours: 0.5\nagents:\n  worker:\n    display_name: Worker\n    run_hours: 2.5\n",
    );
    expect(config.defaults.run_hours).toBe(0.5);
    expect(config.agents.worker?.run_hours).toBe(2.5);
    for (const hours of [0, -1, 25])
      expect(() => parseConfig(`defaults:\n  run_hours: ${hours}\n`)).toThrow();
  });

  it("honors an existing custom message limit", () => {
    expect(
      parseConfig("defaults:\n  max_consecutive_agent_messages: 5\n").defaults
        .max_consecutive_agent_messages,
    ).toBe(5);
  });

  it("rejects names reserved for the lead and mentions", () => {
    for (const name of ["lead", "all", "user"]) {
      expect(() =>
        parseConfig(`agents:\n  ${name}:\n    display_name: Test\n`),
      ).toThrow(/reserved/i);
    }
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

it("sets the configurable per-app coordination limit", () => {
  expect(parseConfig("{}").multi_agent.max_per_app).toBe(4);
  expect(
    parseConfig("multi_agent:\n  max_per_app: 7\n").multi_agent.max_per_app,
  ).toBe(7);
  expect(() => parseConfig("multi_agent:\n  max_per_app: 0\n")).toThrow();
});
