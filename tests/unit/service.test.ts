import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { buildApp } from "../../src/server/api/app.js";
import {
  generateToken,
  KonfabService,
  parseMentions,
  type WaitResult,
} from "../../src/server/domain/service.js";

const ROOM = "test";
const TURN_TIMEOUT_MS = 30 * 60_000;

function expectTurn(result: WaitResult) {
  if (result.status !== "turn")
    throw new Error(`Expected a turn, got ${result.status}`);
  return result;
}

describe("parseMentions", () => {
  it("finds unique lowercase mentions", () => {
    expect(parseMentions("@Claude and @codex, then @claude")).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("ignores emails and code", () => {
    expect(parseMentions("me@claude.com `@codex` ```\n@all\n```")).toEqual([]);
  });
});

describe("KonfabService", () => {
  let db: Db;
  let service: KonfabService;
  let now: number;
  let claude: string;
  let codex: string;

  const createService = (): KonfabService =>
    new KonfabService(db, {
      now: () => now,
      waitTimeoutSeconds: 50,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      maxMessageChars: 100,
    });

  beforeEach(() => {
    now = 1_000_000;
    db = openDatabase(":memory:");
    service = createService();
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    service.createRoom(ROOM, "Topic", ["claude", "codex"]);
    claude = service.join("claude", ROOM).session_id;
    codex = service.join("codex", ROOM).session_id;
  });

  afterEach(() => db.close());

  it("allows a flagged lead mention alongside an existing ordinary turn", () => {
    service = new KonfabService(db, {
      now: () => now,
      waitTimeoutSeconds: 50,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      maxMessageChars: 100,
      parallelLeadMentions: true,
    });
    service.updateRoom(ROOM, { parallel_lead_mentions: true });
    service.postUserMessage(ROOM, "Begin work");
    const first = expectTurn(service.poll("claude", claude, true));
    service.postUserMessage(ROOM, "@codex respond");
    const second = expectTurn(service.poll("codex", codex, true));
    expect(second.messages.some((m) => m.body === "@codex respond")).toBe(true);
    expect(expectTurn(service.poll("claude", claude, true)).turn_id).toBe(
      first.turn_id,
    );
    expect(expectTurn(service.poll("codex", codex, true)).turn_id).toBe(
      second.turn_id,
    );
  });

  it("caps parallel requests, preserves busy mentions, and repeats notices until claim", () => {
    service = new KonfabService(db, {
      now: () => now,
      waitTimeoutSeconds: 50,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      maxMessageChars: 100,
      parallelLeadMentions: true,
      maxParallelLeadTurns: 1,
    });
    service.updateRoom(ROOM, { parallel_lead_mentions: true });
    service.postUserMessage(ROOM, "Begin work");
    const first = expectTurn(service.poll("claude", claude, true));
    const msg = service.postUserMessage(ROOM, "@claude @codex respond");
    expect(service.pendingLeadMentions("claude", claude)).toEqual([
      { message_id: msg.message_id },
    ]);
    expect(service.pendingLeadMentions("claude", claude)).toHaveLength(1);
    const parallel = expectTurn(service.poll("codex", codex, true));
    expect(service.poll("claude", claude, true)).toMatchObject({
      turn_id: first.turn_id,
    });
    service.passTurn("claude", claude, first.turn_id);
    expect(service.poll("claude", claude, true).status).toBe("idle");
    service.passTurn("codex", codex, parallel.turn_id);
    expectTurn(service.poll("claude", claude, true));
    expect(service.pendingLeadMentions("claude", claude)).toHaveLength(0);
  });

  it("requeues a timed-out parallel turn with its source intact", () => {
    service.updateRoom(ROOM, { parallel_lead_mentions: true });
    const message = service.postUserMessage(ROOM, "@codex respond");
    const first = expectTurn(service.poll("codex", codex, true));
    now += TURN_TIMEOUT_MS + 1;
    service.tick();
    const retry = expectTurn(service.poll("codex", codex, true));
    expect(retry.turn_id).not.toBe(first.turn_id);
    expect(() => service.passTurn("codex", codex, first.turn_id)).toThrow();
    expect(retry.parallel?.source_message_id).toBe(message.message_id);
  });

  it("shows pending mention state only in its own room", () => {
    service.updateRoom(ROOM, { parallel_lead_mentions: true });
    service.createRoom("other", "", ["claude"]);
    service.join("claude", "other");
    now += 1000;
    service.postUserMessage(ROOM, "@claude question");
    expect(
      service.roomState(ROOM).agents.find((agent) => agent.id === "claude")
        ?.pending_mention_since,
    ).toBe(now);
    expect(
      service.roomState("other").agents[0]?.pending_mention_since,
    ).toBeNull();
    expectTurn(service.poll("claude", claude, true));
    expect(
      service.roomState(ROOM).agents.find((agent) => agent.id === "claude")
        ?.pending_mention_since,
    ).toBeNull();
  });

  it("holds parallel mentions during pause", () => {
    service.updateRoom(ROOM, { parallel_lead_mentions: true });
    service.postUserMessage(ROOM, "@codex respond");
    service.setRoomPaused(ROOM, true);
    expect(service.poll("codex", codex, true).status).toBe("idle");
    service.setRoomPaused(ROOM, false);
    expectTurn(service.poll("codex", codex, true));
  });

  it("reopens a real database and preserves the active and queued parallel turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "konfab-parallel-"));
    const path = join(dir, "test.db");
    const options = {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      maxMessageChars: 100,
    };
    let disk = openDatabase(path);
    try {
      let app = new KonfabService(disk, options);
      app.ensureAgent("a", "A");
      app.ensureAgent("b", "B");
      app.createRoom("disk", "", ["a", "b"]);
      app.updateRoom("disk", { parallel_lead_mentions: true });
      const a = app.join("a", "disk").session_id;
      const b = app.join("b", "disk").session_id;
      app.postUserMessage("disk", "ordinary");
      const original = expectTurn(app.poll("a", a, true));
      app.postUserMessage("disk", "@b parallel");
      const parallel = expectTurn(app.poll("b", b, true));
      app.postUserMessage("disk", "@b follow-up");
      const firstApp = await buildApp({ service: app, port: 19797 });
      await firstApp.ready();
      await firstApp.close();
      disk.close();
      disk = openDatabase(path);
      app = new KonfabService(disk, options);
      app.recoverAfterRestart();
      const nextApp = await buildApp({ service: app, port: 19797 });
      await nextApp.ready();
      await nextApp.close();
      expect(expectTurn(app.poll("a", a, true)).turn_id).toBe(original.turn_id);
      expect(expectTurn(app.poll("b", b, true)).turn_id).toBe(parallel.turn_id);
      expect(app.pendingLeadMentions("b", b)).toHaveLength(1);
      app.passTurn("b", b, parallel.turn_id);
      expectTurn(app.poll("b", b, true));
    } finally {
      disk.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves serial scheduling by default", () => {
    service.postUserMessage(ROOM, "Begin work");
    expectTurn(service.poll("claude", claude, true));
    service.postUserMessage(ROOM, "@codex respond");
    expect(service.poll("codex", codex, true).status).toBe("idle");
  });

  it("stores an explicit existing project folder and rejects invalid paths", () => {
    service.updateRoom(ROOM, { project_path: tmpdir() });
    expect(service.roomState(ROOM).room.project_path).toBe(
      realpathSync(tmpdir()),
    );
    expect(() =>
      service.updateRoom(ROOM, { project_path: "relative" }),
    ).toThrow();
    expect(service.roomState(ROOM).room.project_path).toBe(
      realpathSync(tmpdir()),
    );
    service.updateRoom(ROOM, { project_path: null });
    expect(service.roomState(ROOM).room.project_path).toBeNull();
  });

  it("records completed waits and one inferred contact loss per lapse", () => {
    service.beginObservedWait("claude", claude, "call-one");
    now += 12_000;
    service.finishObservedWait("claude", claude, "call-one");
    service.beginObservedWait("claude", claude, "interrupted");
    now += 100_000;
    service.tick();
    service.tick();
    const first = service.activity(ROOM);
    expect(
      first.filter(
        (event) => event.type === "contact_lost" && event.agent_id === "claude",
      ),
    ).toHaveLength(1);
    expect(
      first.find(
        (event) => event.type === "contact_lost" && event.agent_id === "claude",
      )?.last_contact_at,
    ).toBe(1_000_000);
    expect(
      service.roomState(ROOM).agents.find((a) => a.id === "claude")?.stats
        .longest_wait_ms,
    ).toBe(12_000);
    service.poll("claude", claude, true);
    expect(
      service
        .activity(ROOM)
        .some(
          (event) =>
            event.type === "contact_restored" && event.agent_id === "claude",
        ),
    ).toBe(true);
  });

  it("computes median answer time excluding permission waits", () => {
    service.postUserMessage(ROOM, "@claude work");
    const first = expectTurn(service.poll("claude", claude, true));
    now += 2_000;
    const permission = service.requestPermission("claude", claude, {
      recipient: "example.test",
      data_description: "test",
      reason: "test",
    });
    now += 10_000;
    service.decidePermission(permission.id, "approved");
    now += 4_000;
    service.postAgentMessage("claude", claude, first.turn_id, "done");
    service.postUserMessage(ROOM, "@claude again");
    const second = expectTurn(service.poll("claude", claude, true));
    now += 8_000;
    service.passTurn("claude", claude, second.turn_id);
    const stats = service
      .roomState(ROOM)
      .agents.find((a) => a.id === "claude")?.stats;
    expect(stats?.median_answer_ms).toBe(7_000);
    expect(stats?.paused_turns).toBe(1);
    expect(service.exportRoom(ROOM).markdown).toContain("## Activity");
  });

  it("does not treat an agent named user as the lead", () => {
    service.ensureAgent("user", "Agent User");
    service.setMembers(ROOM, ["user"]);
    const session = service.join("user", ROOM).session_id;
    expect(
      service.proposeDecision(
        "user",
        session,
        "proposal",
        "agent-user-proposal",
      ).status,
    ).toBe("proposed");
  });

  it("keeps decisions versioned, lead-controlled, and bounded on turns", () => {
    const proposed = service.proposeDecision(
      "claude",
      claude,
      "Ship Tuesday",
      "proposal-one",
    );
    expect(
      service.proposeDecision("claude", claude, "Ship Tuesday", "proposal-one")
        .id,
    ).toBe(proposed.id);
    expect(proposed.status).toBe("proposed");
    expect(service.readDecisions("claude", claude).decisions).toHaveLength(0);
    service.updateDecision(ROOM, proposed.id, "confirm");
    service.updateDecision(ROOM, proposed.id, "revise", "Ship Wednesday");
    expect(service.decisionVersions(ROOM, proposed.id)).toMatchObject([
      { version: 2, body: "Ship Wednesday" },
      { version: 1, body: "Ship Tuesday" },
    ]);
    const rejected = service.proposeDecision(
      "claude",
      claude,
      "Ship Friday",
      "proposal-two",
    );
    service.updateDecision(ROOM, rejected.id, "reject");
    service.createDecision(
      ROOM,
      "x".repeat(1999),
      "user",
      undefined,
      undefined,
      true,
    );
    service.createDecision(
      ROOM,
      "y".repeat(1999),
      "user",
      undefined,
      undefined,
      true,
    );
    service.postUserMessage(ROOM, "@claude work");
    const turn = expectTurn(service.poll("claude", claude, true));
    expect(turn.decisions_total).toBe(3);
    expect(turn.decisions_truncated).toBe(true);
    expect(turn.decisions.map((d) => d.body)).toEqual([
      "x".repeat(1999),
      "y".repeat(1999),
    ]);
    expect(turn.decision_updates).toContainEqual({
      id: rejected.id,
      status: "rejected",
    });
    service.passTurn("claude", claude, turn.turn_id);
    service.postUserMessage(ROOM, "@claude next");
    const nextTurn = expectTurn(service.poll("claude", claude, true));
    expect(nextTurn.decision_updates).toEqual([]);
    const first = service.readDecisions("claude", claude, undefined, 1);
    expect(first.next_after_id).toBe(proposed.id);
    expect(
      service.readDecisions("claude", claude, first.next_after_id!, 10)
        .decisions,
    ).toHaveLength(2);
    service.updateDecision(ROOM, proposed.id, "retire");
    expect(
      service
        .readDecisions("claude", claude)
        .decisions.some((d) => d.id === proposed.id),
    ).toBe(false);
    expect(service.exportRoom(ROOM).markdown).toContain(
      "Version 1 (superseded): Ship Tuesday",
    );
  });

  it("authenticates only valid tokens", () => {
    const token = generateToken();
    service.setAgentToken("claude", token);
    expect(service.authenticateAgent(token)).toBe("claude");
    expect(service.authenticateAgent("wrong")).toBeNull();
  });

  it("is idle when nothing is queued", () => {
    expect(service.poll("claude", claude, true).status).toBe("idle");
  });

  it("gives each member a turn in order after an unaddressed message", () => {
    service.postUserMessage(ROOM, "Hello");

    expect(service.poll("codex", codex, true).status).toBe("idle");
    const first = expectTurn(service.poll("claude", claude, true));
    expect(first.messages.map((message) => message.body)).toEqual(["Hello"]);
    service.postAgentMessage("claude", claude, first.turn_id, "Hi from Claude");

    const second = expectTurn(service.poll("codex", codex, true));
    expect(second.messages.map((message) => message.body)).toEqual([
      "Hello",
      "Hi from Claude",
    ]);
  });

  it("gives a turn only to the agent mentioned by the user", () => {
    service.postUserMessage(ROOM, "@codex please look");
    expect(service.poll("claude", claude, true).status).toBe("idle");
    expect(service.poll("codex", codex, true).status).toBe("turn");
  });

  it("queues an agent mentioned by another agent", () => {
    service.postUserMessage(ROOM, "@claude start");
    const turn = expectTurn(service.poll("claude", claude, true));
    service.postAgentMessage(
      "claude",
      claude,
      turn.turn_id,
      "@codex what do you think?",
    );
    expect(service.poll("codex", codex, true).status).toBe("turn");
  });

  it("does not queue the sender for its own mention", () => {
    service.postUserMessage(ROOM, "@claude start");
    const turn = expectTurn(service.poll("claude", claude, true));
    service.postAgentMessage("claude", claude, turn.turn_id, "Note to @claude");
    expect(service.poll("claude", claude, true).status).toBe("idle");
  });

  function setupParticipants() {
    service.ensureAgent("first", "First");
    service.ensureAgent("second", "Second");
    service.createRoom("participants", "", ["first", "second"]);
    return {
      first: service.join("first", "participants").session_id,
      second: service.join("second", "participants").session_id,
    };
  }

  it("allows fifty consecutive messages, then waits for the lead", () => {
    const sessions = setupParticipants();
    service.postUserMessage("participants", "@first start");
    let agent: "first" | "second" = "first";
    for (let count = 0; count < 50; count += 1) {
      const other: "first" | "second" = agent === "first" ? "second" : "first";
      const turn = expectTurn(service.poll(agent, sessions[agent], true));
      service.postAgentMessage(
        agent,
        sessions[agent],
        turn.turn_id,
        `@${other} reply`,
      );
      agent = other;
    }
    expect(service.poll(agent, sessions[agent], true).status).toBe("idle");
    service.postUserMessage("participants", `@${agent} continue`);
    expect(service.poll(agent, sessions[agent], true).status).toBe("turn");
  });

  it("keeps a passed turn complete", () => {
    const sessions = setupParticipants();
    service.postUserMessage("participants", "@first start");
    const turn = expectTurn(service.poll("first", sessions.first, true));
    service.passTurn("first", sessions.first, turn.turn_id, "Nothing to add");
    expect(service.poll("first", sessions.first, true).status).toBe("idle");
  });

  it("delivers a lead mention without queuing an agent", () => {
    const sessions = setupParticipants();
    service.postUserMessage("participants", "@first start");
    const turn = expectTurn(service.poll("first", sessions.first, true));
    service.postAgentMessage(
      "first",
      sessions.first,
      turn.turn_id,
      "@lead please decide",
    );
    expect(service.poll("second", sessions.second, true).status).toBe("idle");
    expect(
      service.roomState("participants").messages.at(-1)?.mentions,
    ).toContain("lead");
    expect(service.joinPrompt("participants")).toContain("@lead");
    service.postUserMessage("participants", "@lead and @second hello");
    expect(service.poll("second", sessions.second, true).status).toBe("turn");
  });

  it("delivers an agent's all mention to the other members and lead", () => {
    const sessions = setupParticipants();
    service.postUserMessage("participants", "@first start");
    const turn = expectTurn(service.poll("first", sessions.first, true));
    service.postAgentMessage(
      "first",
      sessions.first,
      turn.turn_id,
      "@all update",
    );
    expect(service.poll("second", sessions.second, true).status).toBe("turn");
    expect(
      service.roomState("participants").messages.at(-1)?.mentions,
    ).toContain("all");
  });

  it("shows waiting for approval and queued participants", () => {
    const sessions = setupParticipants();
    service.postUserMessage("participants", "start");
    const turn = expectTurn(service.poll("first", sessions.first, true));
    expect(
      service.roomState("participants").agents.find((a) => a.id === "second")
        ?.state,
    ).toBe("queued");
    const approval = service.requestPermission("first", sessions.first, {
      recipient: "example.test",
      data_description: "file",
      reason: "test",
    });
    expect(
      service.roomState("participants").agents.find((a) => a.id === "first")
        ?.state,
    ).toBe("waiting_approval");
    service.decidePermission(approval.id, "approved");
    expect(
      service.roomState("participants").agents.find((a) => a.id === "first")
        ?.state,
    ).toBe("working");
    service.passTurn("first", sessions.first, turn.turn_id);
  });

  it("delivers a message posted during an active turn on the next turn", () => {
    service.postUserMessage(ROOM, "@claude first");
    const turn = expectTurn(service.poll("claude", claude, true));
    service.postUserMessage(ROOM, "@claude second");
    service.postAgentMessage("claude", claude, turn.turn_id, "Answer");

    const next = expectTurn(service.poll("claude", claude, true));
    expect(next.messages.map((message) => message.body)).toEqual([
      "@claude second",
    ]);
  });

  it("returns the same turn when called again before finishing", () => {
    service.postUserMessage(ROOM, "@claude hi");
    const first = expectTurn(service.poll("claude", claude, true));
    const again = expectTurn(service.poll("claude", claude, true));
    expect(again.turn_id).toBe(first.turn_id);
  });

  it("does not post twice for one turn", () => {
    service.postUserMessage(ROOM, "@claude hi");
    const turn = expectTurn(service.poll("claude", claude, true));
    const first = service.postAgentMessage(
      "claude",
      claude,
      turn.turn_id,
      "Once",
    );
    const second = service.postAgentMessage(
      "claude",
      claude,
      turn.turn_id,
      "Twice",
    );
    expect(second.message_id).toBe(first.message_id);
    expect(
      service.roomState(ROOM).messages.map((message) => message.body),
    ).toEqual(["@claude hi", "Once"]);
  });

  it("replaces the old session and requeues its turn on rejoin", () => {
    service.postUserMessage(ROOM, "@claude hi");
    expectTurn(service.poll("claude", claude, true));

    const rejoined = service.join("claude", ROOM).session_id;
    expect(service.poll("claude", claude, true).status).toBe("replaced");
    const turn = expectTurn(service.poll("claude", rejoined, true));
    expect(turn.messages.map((message) => message.body)).toEqual([
      "@claude hi",
    ]);
  });

  it("skips a timed-out turn and redelivers its messages later", () => {
    service.postUserMessage(ROOM, "@claude hi");
    expectTurn(service.poll("claude", claude, true));
    now += TURN_TIMEOUT_MS;
    service.tick();

    service.postUserMessage(ROOM, "@claude again");
    const next = expectTurn(service.poll("claude", claude, true));
    expect(next.messages.map((message) => message.body)).toEqual([
      "@claude hi",
      "@claude again",
    ]);
    expect(service.roomState(ROOM).agents[0]?.stats.turns_skipped).toBe(1);
  });

  it("keeps other agents idle while one agent has the active turn", () => {
    service.postUserMessage(ROOM, "@claude and @codex");
    const turn = expectTurn(service.poll("claude", claude, true));

    expect(service.poll("codex", codex, true).status).toBe("idle");
    service.postAgentMessage("claude", claude, turn.turn_id, "Done");
    expect(service.poll("codex", codex, true).status).toBe("turn");
  });

  it("moves past an agent that has stopped responding", () => {
    service.postUserMessage(ROOM, "Hello");
    now += 91_000;
    expect(service.poll("codex", codex, true).status).toBe("turn");
  });

  it("preserves active turns and their original timeout after a restart", () => {
    service.postUserMessage(ROOM, "@claude hi");
    const original = expectTurn(service.poll("claude", claude, true));
    const restarted = createService();
    restarted.recoverAfterRestart();
    const turn = expectTurn(restarted.poll("claude", claude, true));
    expect(turn.turn_id).toBe(original.turn_id);
    now += TURN_TIMEOUT_MS + 1;
    restarted.tick();
    expect(
      db.prepare("SELECT state FROM turns WHERE id = ?").get(original.turn_id),
    ).toEqual({ state: "skipped" });
  });

  it("extends active turns on working heartbeat and retries one timeout", () => {
    service.postUserMessage(ROOM, "@claude start");
    const first = expectTurn(service.poll("claude", claude, true));
    now += TURN_TIMEOUT_MS - 1000;
    service.reportStatus("claude", claude, "working", "Implementing");
    now += 2000;
    service.tick();
    expect(service.poll("claude", claude, true).status).toBe("turn");
    now += TURN_TIMEOUT_MS;
    service.poll("claude", claude, true);
    service.tick();
    const retry = expectTurn(service.poll("claude", claude, true));
    expect(retry.turn_id).not.toBe(first.turn_id);
    expect(retry.continuation?.reason).toBe("timeout_recovery");
    now += TURN_TIMEOUT_MS + 1;
    service.poll("claude", claude, true);
    service.tick();
    expect(service.poll("claude", claude, true).status).toBe("idle");
  });

  it("recovers a legacy timeout with a missing message cursor", () => {
    service.postUserMessage(ROOM, "@claude start");
    now += 1;
    const first = expectTurn(service.poll("claude", claude, true));
    db.prepare("UPDATE turns SET last_message_id = NULL WHERE id = ?").run(
      first.turn_id,
    );
    now += TURN_TIMEOUT_MS + 1;
    service.poll("claude", claude, true);
    service.tick();
    expect(
      expectTurn(service.poll("claude", claude, true)).continuation?.reason,
    ).toBe("timeout_recovery");
  });

  it("requeues an active turn whose owning session ended", () => {
    service.postUserMessage(ROOM, "@claude hi");
    const original = expectTurn(service.poll("claude", claude, true));
    db.prepare("UPDATE sessions SET state = 'ended' WHERE id = ?").run(claude);
    createService().recoverAfterRestart();
    expect(
      db.prepare("SELECT state FROM turns WHERE id = ?").get(original.turn_id),
    ).toEqual({ state: "abandoned" });
  });

  it("fires a bounded legacy watchdog and reports why the turn was queued", () => {
    service.postUserMessage(ROOM, "@claude start");
    const turn = expectTurn(service.poll("claude", claude, true));
    const post = service.postAgentMessage(
      "claude",
      claude,
      turn.turn_id,
      "Continuing work",
    );
    const pending = service.roomState(ROOM).routing.automatic;
    expect(pending?.target_agent_id).toBe("claude");
    now += 180_001;
    expect(service.poll("claude", claude, true).status).toBe("idle");
    service.tick();
    const continued = expectTurn(service.poll("claude", claude, true));
    expect(continued.continuation).toMatchObject({
      reason: "watchdog",
      source_message_id: post.message_id,
    });
    service.passTurn("claude", claude, continued.turn_id, "Nothing to do");
    now += 180_001;
    service.poll("claude", claude, true);
    service.tick();
    expect(service.poll("claude", claude, true).status).toBe("idle");
  });

  it("cancels stale plans and does not fire while paused", () => {
    service.postUserMessage(ROOM, "@claude start");
    let turn = expectTurn(service.poll("claude", claude, true));
    service.postAgentMessage("claude", claude, turn.turn_id, "Working further");
    const old = service.roomState(ROOM).routing.automatic!;
    service.cancelAutoContinue(ROOM, old.id);
    expect(() => service.cancelAutoContinue(ROOM, old.id)).toThrow(
      "no longer pending",
    );
    now += 180_001;
    service.poll("claude", claude, true);
    service.tick();
    expect(service.poll("claude", claude, true).status).toBe("idle");
    service.postUserMessage(ROOM, "@claude again");
    turn = expectTurn(service.poll("claude", claude, true));
    service.postAgentMessage("claude", claude, turn.turn_id, "Working further");
    service.setRoomPaused(ROOM, true);
    now += 180_001;
    service.poll("claude", claude, true);
    service.tick();
    expect(service.poll("claude", claude, true).status).toBe("idle");
    service.setRoomPaused(ROOM, false);
    service.poll("claude", claude, true);
    service.tick();
    expect(
      expectTurn(service.poll("claude", claude, true)).continuation?.reason,
    ).toBe("watchdog");
  });

  it("does not schedule a watchdog when disabled", () => {
    service.setAutoContinue(ROOM, false);
    service.postUserMessage(ROOM, "@claude start");
    const turn = expectTurn(service.poll("claude", claude, true));
    service.postAgentMessage("claude", claude, turn.turn_id, "Continuing");
    expect(service.roomState(ROOM).routing.automatic).toBeNull();
    now += 180_001;
    service.poll("claude", claude, true);
    service.tick();
    expect(service.poll("claude", claude, true).status).toBe("idle");
  });

  it("does not auto-continue while an approval is pending", () => {
    service.postUserMessage(ROOM, "@claude start");
    const turn = expectTurn(service.poll("claude", claude, true));
    const approval = service.requestPermission("claude", claude, {
      recipient: "example.org",
      data_description: "test",
      reason: "test",
    });
    service.postAgentMessage(
      "claude",
      claude,
      turn.turn_id,
      "Waiting for approval",
    );
    now += 180_001;
    service.poll("claude", claude, true);
    service.tick();
    expect(service.poll("claude", claude, true).status).toBe("idle");
    expect(service.roomState(ROOM).routing.automatic?.blocked).toBe(
      "permission",
    );
    service.decidePermission(approval.id, "approved");
    service.poll("claude", claude, true);
    service.tick();
    expect(
      expectTurn(service.poll("claude", claude, true)).continuation?.reason,
    ).toBe("watchdog");
  });

  it("caps automatic recoveries per room and stays quiet for done", () => {
    service.postUserMessage(ROOM, "@claude start");
    let turn = expectTurn(service.poll("claude", claude, true));
    for (let n = 0; n < 3; n++) {
      service.postAgentMessage("claude", claude, turn.turn_id, "Continuing");
      now += 180_001;
      service.poll("claude", claude, true);
      service.tick();
      turn = expectTurn(service.poll("claude", claude, true));
    }
    service.postAgentMessage("claude", claude, turn.turn_id, "More work");
    now += 180_001;
    service.poll("claude", claude, true);
    service.tick();
    expect(service.poll("claude", claude, true).status).toBe("idle");
    expect(service.roomState(ROOM).routing.automatic?.capped).toBe(true);
    now += 60 * 60_000 + 1;
    service.poll("claude", claude, true);
    service.tick();
    expect(service.roomState(ROOM).routing.automatic?.capped).toBe(true);
    expect(service.poll("claude", claude, true).status).toBe("idle");
    service.postUserMessage(ROOM, "@claude final");
    turn = expectTurn(service.poll("claude", claude, true));
    service.postAgentMessage("claude", claude, turn.turn_id, "Finished", {
      kind: "done",
    });
    expect(service.roomState(ROOM).routing.automatic).toBeNull();
  });

  it("queues explicit self continuation exactly once and returns its source", () => {
    service.postUserMessage(ROOM, "@claude start");
    const turn = expectTurn(service.poll("claude", claude, true));
    const posted = service.postAgentMessage(
      "claude",
      claude,
      turn.turn_id,
      "Continuing",
      { kind: "self" },
    );
    expect(
      service.postAgentMessage("claude", claude, turn.turn_id, "Continuing", {
        kind: "self",
      }),
    ).toEqual(posted);
    const next = expectTurn(service.poll("claude", claude, true));
    expect(next.continuation).toMatchObject({
      reason: "self",
      source_message_id: posted.message_id,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM turns WHERE room_id = ? AND state = 'queued'",
        )
        .get(1),
    ).toEqual({ n: 0 });
  });

  it("deduplicates explicit handoffs and rejects conflicting lead decisions", () => {
    service.postUserMessage(ROOM, "@claude start");
    const turn = expectTurn(service.poll("claude", claude, true));
    expect(() =>
      service.postAgentMessage(
        "claude",
        claude,
        turn.turn_id,
        "@codex please",
        { kind: "done" },
      ),
    ).toThrow("cannot be combined");
    expect(() =>
      service.postAgentMessage("claude", claude, turn.turn_id, "Next", {
        kind: "agent",
        agent_id: "missing",
      }),
    ).toThrow("room member");
    const post = service.postAgentMessage(
      "claude",
      claude,
      turn.turn_id,
      "@codex review",
      { kind: "agent", agent_id: "codex" },
    );
    const repair = service.handOff("claude", claude, post.message_id, "codex");
    expect(expectTurn(service.poll("codex", codex, true)).turn_id).toBe(
      repair.turn_id,
    );
  });

  it("does not warn or enqueue when explicitly waiting on the lead", () => {
    service.postUserMessage(ROOM, "@claude start");
    const turn = expectTurn(service.poll("claude", claude, true));
    const post = service.postAgentMessage(
      "claude",
      claude,
      turn.turn_id,
      "@lead your call",
      { kind: "lead" },
    );
    expect(post.routing_warning).toBeUndefined();
    expect(service.poll("codex", codex, true).status).toBe("idle");
  });

  it("warns on a missing recipient and repairs it once", () => {
    service.postUserMessage(ROOM, "@claude start");
    const turn = expectTurn(service.poll("claude", claude, true));
    const posted = service.postAgentMessage(
      "claude",
      claude,
      turn.turn_id,
      "@lead and @claude: ready for review",
    );
    expect(posted.routing_warning).toContain("hand_off");
    expect(service.roomState(ROOM).routing.no_continuation).toBe(false);
    expect(() =>
      service.handOff("codex", codex, posted.message_id, "claude"),
    ).toThrow("Only the author");
    const repair = service.handOff(
      "claude",
      claude,
      posted.message_id,
      "codex",
    );
    expect(
      service.handOff("claude", claude, posted.message_id, "codex"),
    ).toEqual(repair);
    expect(
      service.postAgentMessage("claude", claude, turn.turn_id, "A retry"),
    ).toEqual(posted);
    const next = expectTurn(service.poll("codex", codex, true));
    expect(next.turn_id).toBe(repair.turn_id);
    expect(next.handoff_repair?.source_message_id).toBe(posted.message_id);
    expect(
      service
        .activity(ROOM)
        .filter((event) => event.type === "handoff_repaired"),
    ).toHaveLength(1);
  });

  it("does not warn when a continuation is already queued or explicitly mentioned", () => {
    service.postUserMessage(ROOM, "Start");
    const turn = expectTurn(service.poll("claude", claude, true));
    expect(
      service.postAgentMessage("claude", claude, turn.turn_id, "Done")
        .routing_warning,
    ).toBeUndefined();
    const next = expectTurn(service.poll("codex", codex, true));
    expect(
      service.postAgentMessage("codex", codex, next.turn_id, "@claude continue")
        .routing_warning,
    ).toBeUndefined();
  });

  it("refuses unavailable, stale and over-limit handoffs", () => {
    service.postUserMessage(ROOM, "@claude start");
    const turn = expectTurn(service.poll("claude", claude, true));
    const posted = service.postAgentMessage(
      "claude",
      claude,
      turn.turn_id,
      "Done",
    );
    expect(() =>
      service.handOff("claude", claude, posted.message_id, "claude"),
    ).toThrow("another member");
    service.setRoomPaused(ROOM, true);
    expect(service.roomState(ROOM).routing.no_continuation).toBe(false);
    expect(() =>
      service.handOff("claude", claude, posted.message_id, "codex"),
    ).toThrow("paused");
    service.setRoomPaused(ROOM, false);
    db.prepare("UPDATE rooms SET agent_streak = 50 WHERE name = ?").run(ROOM);
    expect(() =>
      service.handOff("claude", claude, posted.message_id, "codex"),
    ).toThrow("limit reached");
    db.prepare("UPDATE rooms SET agent_streak = 1 WHERE name = ?").run(ROOM);
    db.prepare("UPDATE sessions SET state = 'ended' WHERE id = ?").run(codex);
    expect(() =>
      service.handOff("claude", claude, posted.message_id, "codex"),
    ).toThrow("rejoin codex");
    now += 10 * 60_000 + 1;
    expect(() =>
      service.handOff("claude", claude, posted.message_id, "codex"),
    ).toThrow("last 10 minutes");
  });

  it("keeps skipped messages unread when reading out of order", () => {
    const roomId = service.roomState(ROOM).room.id;
    const insert = db.prepare(
      "INSERT INTO messages (room_id, sender_type, sender_id, body, mentions, created_at) VALUES (?, 'agent', 'claude', ?, ?, ?)",
    );
    const first = Number(
      insert.run(roomId, "First", "[]", now).lastInsertRowid,
    );
    const second = Number(
      insert.run(roomId, "Second", '["lead"]', now).lastInsertRowid,
    );
    const third = Number(
      insert.run(roomId, "Third", "[]", now).lastInsertRowid,
    );
    expect(service.markLeadRead(ROOM, [third])).toMatchObject({
      cursor: 0,
      unread_count: 2,
      first_unread_id: first,
      attention_count: 1,
    });
    expect(service.markLeadRead(ROOM, [first])).toMatchObject({
      cursor: first,
      unread_count: 1,
    });
    expect(service.markLeadRead(ROOM, [second, second])).toMatchObject({
      cursor: third,
      unread_count: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM lead_seen_messages").get(),
    ).toEqual({ count: 0 });
  });

  it("validates read batches atomically and posting marks earlier messages read", () => {
    const roomId = service.roomState(ROOM).room.id;
    const id = Number(
      db
        .prepare(
          "INSERT INTO messages (room_id, sender_type, sender_id, body, created_at) VALUES (?, 'agent', 'claude', 'Unread', ?)",
        )
        .run(roomId, now).lastInsertRowid,
    );
    service.createRoom("other-read", "", ["claude"]);
    const other = service.roomState("other-read").room.id;
    const foreign = Number(
      db
        .prepare(
          "INSERT INTO messages (room_id, sender_type, sender_id, body, created_at) VALUES (?, 'agent', 'claude', 'Other', ?)",
        )
        .run(other, now).lastInsertRowid,
    );
    expect(() => service.markLeadRead(ROOM, [id, foreign])).toThrow(
      "belong to this room",
    );
    expect(service.roomState(ROOM).read_info.unread_count).toBe(1);
    service.postUserMessage(ROOM, "My reply");
    expect(service.roomState(ROOM).read_info.unread_count).toBe(0);
    expect(service.roomState("other-read").read_info.unread_count).toBe(1);
  });

  it("reports and pages unread messages older than the latest 500", () => {
    const roomId = service.roomState(ROOM).room.id;
    const insert = db.prepare(
      "INSERT INTO messages (room_id, sender_type, sender_id, body, created_at) VALUES (?, 'agent', 'claude', 'Backlog', ?)",
    );
    db.transaction(() => {
      for (let i = 0; i < 501; i++) insert.run(roomId, now);
    })();
    const state = service.roomState(ROOM);
    expect(state.messages).toHaveLength(500);
    expect(state.read_info).toMatchObject({
      unread_count: 501,
      older_unread_count: 1,
    });
    const page = service.leadMessagePage(ROOM, state.messages[0]!.id);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.unread).toBe(true);
    expect(page.read_info.older_unread_count).toBe(0);
    service.markLeadRead(ROOM, [], true);
    expect(service.roomState(ROOM).read_info.unread_count).toBe(0);
  });

  it("tracks bounded working status separately and clears it on post or pass", () => {
    expect(() =>
      service.reportStatus("claude", claude, "working", "x".repeat(121)),
    ).toThrow("120");
    expect(() =>
      service.reportStatus("claude", claude, "working", "two\nlines"),
    ).toThrow("one line");
    service.reportStatus("claude", claude, "working", "Running checks");
    expect(service.listReports()).toEqual([]);
    expect(service.roomState(ROOM).agents[0]?.working?.detail).toBe(
      "Running checks",
    );
    expect(service.roomState(ROOM).agents[1]?.working).toBeNull();
    now += TURN_TIMEOUT_MS + 1;
    expect(service.roomState(ROOM).agents[0]?.working?.stale).toBe(true);
    service.postUserMessage(ROOM, "@claude reply");
    const turn = expectTurn(service.poll("claude", claude, true));
    service.postAgentMessage("claude", claude, turn.turn_id, "Done");
    expect(service.roomState(ROOM).agents[0]?.working).toBeNull();
    service.reportStatus("claude", claude, "working", "Reviewing");
    service.postUserMessage(ROOM, "@claude next");
    const next = expectTurn(service.poll("claude", claude, true));
    service.passTurn("claude", claude, next.turn_id);
    expect(service.roomState(ROOM).agents[0]?.working).toBeNull();
    const events = service.activity(ROOM).map((event) => event.type);
    expect(events.filter((type) => type === "working_cleared")).toHaveLength(2);
  });

  it("does not carry working status into a replacement session or another room", () => {
    service.reportStatus("claude", claude, "working", "Reviewing");
    service.createRoom("other-room", "Other", ["claude"]);
    service.join("claude", "other-room");
    expect(service.roomState("other-room").agents[0]?.working).toBeNull();
    service.join("claude", ROOM);
    expect(service.roomState(ROOM).agents[0]?.working).toBeNull();
  });

  it("reports agent state and idle call measurements", () => {
    expect(service.roomState(ROOM).agents[0]?.state).toBe("waiting");
    service.poll("claude", claude, true);
    now += 50_000;
    service.poll("claude", claude, true);
    now += 200_000;

    const agent = service.roomState(ROOM).agents[0];
    expect(agent?.state).toBe("not_responding");
    expect(agent?.stats.model_wait_calls).toBe(2);
    expect(agent?.stats.longest_gap_ms).toBe(50_000);
    expect(agent?.stats.calls_per_hour).toBe(72);
  });

  it("rejects empty and oversized messages", () => {
    expect(() => service.postUserMessage(ROOM, "  ")).toThrow("empty");
    expect(() => service.postUserMessage(ROOM, "x".repeat(101))).toThrow(
      "exceeds",
    );
  });

  it("rejects another agent's session", () => {
    expect(() => service.poll("codex", claude, true)).toThrow(
      "Unknown session",
    );
  });
});
