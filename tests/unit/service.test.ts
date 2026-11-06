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
      maxConsecutiveAgentMessages: 5,
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
    service.ensureRoom(ROOM, "Topic", ["claude", "codex"]);
    claude = service.join("claude", ROOM).session_id;
    codex = service.join("codex", ROOM).session_id;
  });

  afterEach(() => db.close());

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

  it("stops after the streak limit until the user posts", () => {
    service.postUserMessage(ROOM, "@claude start");
    let agent: "claude" | "codex" = "claude";
    for (let count = 0; count < 5; count += 1) {
      const session = agent === "claude" ? claude : codex;
      const other: "claude" | "codex" = agent === "claude" ? "codex" : "claude";
      const turn = expectTurn(service.poll(agent, session, true));
      service.postAgentMessage(agent, session, turn.turn_id, `@${other} reply`);
      agent = other;
    }
    expect(
      service.poll(agent, agent === "claude" ? claude : codex, true).status,
    ).toBe("idle");

    service.postUserMessage(ROOM, "@claude continue");
    expect(service.poll("claude", claude, true).status).toBe("turn");
  });

  it("does not count a pass toward the streak or lose later messages", () => {
    service.postUserMessage(ROOM, "@claude start");
    const turn = expectTurn(service.poll("claude", claude, true));
    service.passTurn("claude", claude, turn.turn_id, "Nothing to add");
    expect(service.roomState(ROOM).room.agent_streak).toBe(0);
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

  it("requeues active turns after a restart", () => {
    service.postUserMessage(ROOM, "@claude hi");
    expectTurn(service.poll("claude", claude, true));

    const restarted = createService();
    restarted.recoverAfterRestart();
    const turn = expectTurn(restarted.poll("claude", claude, true));
    expect(turn.messages.map((message) => message.body)).toEqual([
      "@claude hi",
    ]);
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
