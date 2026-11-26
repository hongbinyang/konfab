import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../../src/server/config.js";
import { takeOn } from "../../src/server/live-settings.js";
import { createRuntime, type Runtime } from "../../src/server/runtime.js";

const noNetwork = {
  fetch: async () => {
    throw new Error("no network expected");
  },
};

/** A file as the lead could write it, read the way the server reads it. */
const file = (text: string): Config => parseConfig(text);

describe("settings that a running server takes on", () => {
  let home: string;
  let runtime: Runtime;
  let inUse: Config;
  const change = (text: string) => {
    inUse = takeOn(inUse, file(text));
    runtime.useConfig(inUse);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "konfab-live-"));
    inUse = file("");
    runtime = createRuntime(join(home, "konfab.db"), inUse, noNetwork);
    runtime.service.ensureAgent("claude", "Claude");
    runtime.service.createRoom("own", "", ["claude"]);
    runtime.service.createRoom("plain", "", ["claude"]);
    runtime.service.updateRoom("own", { checkin_minutes: 10 });
  });
  afterEach(async () => {
    await runtime.sources.close();
    runtime.db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("takes on what is in use at once, and leaves the rest for a restart", () => {
    const saved = file(`
defaults:
  max_message_chars: 50
  max_attachment_mb: 20
  run_warnings_minutes: [15]
server:
  port: 9001
  tick_seconds: 3
pre_approvals:
  - recipient: github.com/a/b
    data: code_push
agents:
  claude:
    display_name: Claude A
    run_hours: 2
`);
    const next = takeOn(file(""), saved);
    expect(next.defaults).toMatchObject({
      max_message_chars: 50,
      run_warnings_minutes: [15],
      max_attachment_mb: 10,
    });
    expect(next.server).toEqual(file("").server);
    expect(next.pre_approvals).toEqual([
      { recipient: "github.com/a/b", data: "code_push" },
    ]);
    expect(next.agents.claude).toMatchObject({
      display_name: "Claude A",
      run_hours: 2,
    });
    // Nothing that isn't in the file is made up.
    expect(takeOn(next, saved)).toEqual(next);
  });

  it("limits messages by the new length at once", () => {
    const long = "x".repeat(100);
    runtime.service.postUserMessage("plain", long);
    change("defaults:\n  max_message_chars: 50\n");
    expect(() => runtime.service.postUserMessage("plain", long)).toThrow(
      "exceeds 50 characters",
    );
  });

  it("gives rooms without their own check-in the new default, and leaves a room's own", () => {
    change("defaults:\n  checkin_minutes: 5\n");
    expect(runtime.service.roomState("plain").room).toMatchObject({
      checkin_minutes: null,
      checkin_default: 5,
    });
    expect(runtime.service.roomState("own").room.checkin_minutes).toBe(10);
  });

  it("keeps the end of a running session, and gives the next join the new run hours", () => {
    runtime.service.join("claude", "plain");
    const end = runtime.service.roomState("plain").agents[0]!.closes_at!;
    change("agents:\n  claude:\n    display_name: Claude\n    run_hours: 1\n");
    expect(runtime.service.roomState("plain").agents[0]!.closes_at).toBe(end);
    runtime.service.join("claude", "plain");
    const next = runtime.service.roomState("plain").agents[0]!.closes_at!;
    expect(next).toBeLessThan(end);
    expect(next - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    expect(next - Date.now()).toBeGreaterThan(59 * 60_000);
  });

  it("tells the new wait time, and names an agent anew", () => {
    change(
      "defaults:\n  wait_timeout_seconds: 20\nagents:\n  claude:\n    display_name: Claudia\n",
    );
    expect(runtime.service.waitSeconds).toBe(20);
    expect(runtime.service.roomState("plain").agents[0]).toMatchObject({
      display_name: "Claudia",
    });
  });

  it("uses a new pre-approval for new requests only, and a removal at once", () => {
    const session = runtime.service.join("claude", "plain").session_id;
    const ask = () =>
      runtime.service.requestPermission("claude", session, {
        recipient: "github.com/a/b",
        data_description: "Commits",
        reason: "Push",
        data_type: "code_push",
        push_scope: {
          repository: "github.com/a/b",
          branch: "x",
          base: "a".repeat(40),
          head: "b".repeat(40),
        },
      });
    const waiting = ask();
    expect(waiting.state).toBe("pending");
    change(
      "pre_approvals:\n  - recipient: github.com/a/b\n    data: code_push\n",
    );
    expect(ask()).toMatchObject({
      state: "approved",
      decided_by: "pre_approval",
    });
    // The one that waited isn't approved after the fact.
    expect(
      runtime.service
        .listPermissions("pending")
        .some((one) => one.id === waiting.id),
    ).toBe(true);
    change("pre_approvals: []\n");
    expect(ask().state).toBe("pending");
  });

  it("shows the new streak limit in a room", () => {
    change("defaults:\n  max_consecutive_agent_messages: 7\n");
    expect(runtime.service.roomState("plain").room.streak_limit).toBe(7);
  });
});
