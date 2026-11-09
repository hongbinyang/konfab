import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/server/db/index.js";
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

  it("requeues an active turn whose owning session ended", () => {
    service.postUserMessage(ROOM, "@claude hi");
    const original = expectTurn(service.poll("claude", claude, true));
    db.prepare("UPDATE sessions SET state = 'ended' WHERE id = ?").run(claude);
    createService().recoverAfterRestart();
    expect(
      db.prepare("SELECT state FROM turns WHERE id = ?").get(original.turn_id),
    ).toEqual({ state: "abandoned" });
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
