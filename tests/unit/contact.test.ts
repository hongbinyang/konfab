import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";

const ROOM = "contact";
const WAIT_LIMIT_MS = 90_000; // the live window routing uses

describe("contact status", () => {
  let db: Db;
  let now: number;
  let service: KonfabService;
  let claude: string;

  const createService = () =>
    new KonfabService(db, {
      now: () => now,
      waitTimeoutSeconds: 50,
      turnTimeoutMs: 30 * 60_000,
      maxMessageChars: 1000,
      defaultCheckinMinutes: 2,
    });
  const state = (agent = "claude") =>
    service.roomState(ROOM).agents.find((item) => item.id === agent)?.state;
  const events = (agent = "claude") =>
    service
      .activity(ROOM)
      .filter((event) => event.agent_id === agent)
      .map((event) => event.type);

  beforeEach(() => {
    now = 1_000_000;
    db = openDatabase(":memory:");
    service = createService();
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    service.createRoom(ROOM, "", ["claude", "codex"]);
    claude = service.join("claude", ROOM).session_id;
    service.join("codex", ROOM);
  });

  afterEach(() => db.close());

  it("uses one limit for the card and the contact-lost event", () => {
    service.poll("claude", claude, true);
    now += WAIT_LIMIT_MS;
    service.tick();
    expect(state()).toBe("waiting");
    expect(events()).not.toContain("contact_lost");
    now += 1;
    service.tick();
    expect(state()).toBe("not_responding");
    expect(events()).toContain("contact_lost");
    service.poll("claude", claude, true);
    expect(state()).toBe("waiting");
    expect(events()).toContain("contact_restored");
  });

  it("does not flag an agent that reports work every check-in interval", () => {
    service.reportStatus("claude", claude, "working", "Refactoring");
    for (let i = 0; i < 5; i += 1) {
      now += 2 * 60_000;
      service.tick();
      expect(state()).not.toBe("not_responding");
      service.reportStatus("claude", claude, "working", `Step ${i}`);
    }
    expect(events()).not.toContain("contact_lost");
  });

  it("flags a working agent after two missed check-ins", () => {
    service.reportStatus("claude", claude, "working", "Refactoring");
    now += 2 * 2 * 60_000 + 60_000;
    service.tick();
    expect(state()).toBe("waiting");
    now += 1;
    service.tick();
    expect(state()).toBe("not_responding");
    expect(service.roomState(ROOM).agents[0]?.working?.detail).toBe(
      "Refactoring",
    );
  });

  it("follows the room's check-in interval", () => {
    service.updateRoom(ROOM, { checkin_minutes: 10 });
    service.reportStatus("claude", claude, "working", "Long build");
    now += 15 * 60_000;
    service.tick();
    expect(state()).not.toBe("not_responding");
    now += 6 * 60_000 + 1;
    service.tick();
    expect(state()).toBe("not_responding");
  });

  it("never flags an agent during its active turn", () => {
    service.postUserMessage(ROOM, "@claude long task");
    service.poll("claude", claude, true);
    now += 20 * 60_000;
    service.tick();
    expect(state()).toBe("working");
    expect(events()).not.toContain("contact_lost");
  });

  it("does not flag agents on a break", () => {
    service.poll("claude", claude, true);
    service.takeBreak(ROOM);
    now += 10 * 60_000;
    service.tick();
    expect(events()).not.toContain("contact_lost");
  });

  it("gives agents a fresh grace period after a server restart", () => {
    service.poll("claude", claude, true);
    now += 30 * 60_000;
    service = createService();
    expect(state()).toBe("waiting");
    service.tick();
    expect(events().filter((type) => type === "contact_lost")).toHaveLength(0);
    now += WAIT_LIMIT_MS + 1;
    service.tick();
    expect(state()).toBe("not_responding");
  });

  it("reports mentioned agents that cannot hear the lead", () => {
    service.poll("claude", claude, true);
    now += WAIT_LIMIT_MS + 1;
    const lastClaude = 1_000_000;
    const direct = service.postUserMessage(ROOM, "@claude are you there?");
    expect(direct.unreachable).toEqual([
      expect.objectContaining({
        agent_id: "claude",
        state: "not_responding",
        last_contact_at: lastClaude,
      }),
    ]);
    const all = service.postUserMessage(ROOM, "@all status please");
    expect(all.unreachable.map((item) => item.agent_id).sort()).toEqual([
      "claude",
      "codex",
    ]);
    expect(service.postUserMessage(ROOM, "no mention").unreachable).toEqual([]);
  });

  it("lists nothing when mentioned agents are listening, and not-joined agents as such", () => {
    service.poll("claude", claude, true);
    expect(
      service.postUserMessage(ROOM, "@claude quick one").unreachable,
    ).toEqual([]);
    service.ensureAgent("qa", "QA");
    service.setMembers(ROOM, ["claude", "codex", "qa"]);
    expect(service.postUserMessage(ROOM, "@qa hello").unreachable).toEqual([
      { agent_id: "qa", state: "not_joined", last_contact_at: null },
    ]);
  });

  it("tells agents to stay in the loop in the join prompt", () => {
    const prompt = service.joinPrompt(ROOM);
    expect(prompt).toContain("Stop only if the status is closed or replaced");
    expect(prompt).toContain("or the lead tells you to stop");
    expect(prompt).toContain(
      "After every post or pass, call wait_for_turn again",
    );
    expect(prompt).not.toContain("Never end your reply");
  });

  describe("agreement with routing", () => {
    const eligible = () => service.roomState(ROOM).routing.eligible_agents;

    it("shows a waiting agent as no contact exactly when routing skips it", () => {
      service.poll("claude", claude, true);
      now += WAIT_LIMIT_MS;
      expect(state()).toBe("waiting");
      expect(eligible()).toContain("claude");
      now += 1;
      expect(state()).toBe("not_responding");
      expect(eligible()).not.toContain("claude");
      service.tick();
      expect(events()).toContain("contact_lost");
    });

    it("refuses a handoff to an agent with no contact, and allows it once it is back", () => {
      const codex = service.join("codex", ROOM).session_id;
      service.postUserMessage(ROOM, "@claude start");
      const turn = service.poll("claude", claude, true);
      if (turn.status !== "turn") throw new Error("expected a turn");
      const posted = service.postAgentMessage(
        "claude",
        claude,
        turn.turn_id,
        "@lead and @claude: ready for review",
      );
      now += WAIT_LIMIT_MS + 1;
      service.poll("claude", claude, true);
      expect(state("codex")).toBe("not_responding");
      expect(() =>
        service.handOff("claude", claude, posted.message_id, "codex"),
      ).toThrow();
      service.poll("codex", codex, true);
      expect(state("codex")).not.toBe("not_responding");
      expect(
        service.handOff("claude", claude, posted.message_id, "codex").turn_id,
      ).toBeGreaterThan(0);
    });

    it("keeps routing and the card in step after a restart", () => {
      service.poll("claude", claude, true);
      now += 30 * 60_000;
      service = createService();
      expect(state()).toBe("waiting");
      expect(eligible()).toContain("claude");
      now += WAIT_LIMIT_MS + 1;
      expect(state()).toBe("not_responding");
      expect(eligible()).not.toContain("claude");
    });

    it("treats an agent working outside a turn as busy, not lost", () => {
      service.reportStatus("claude", claude, "working", "Long build");
      now += 3 * 60_000;
      expect(state()).not.toBe("not_responding");
      expect(eligible()).not.toContain("claude");
      expect(service.roomState(ROOM).routing.working).toContain("claude");
    });
  });

  describe("quiet active turns", () => {
    const card = () =>
      service.roomState(ROOM).agents.find((item) => item.id === "claude");
    const startTurn = () => {
      service.postUserMessage(ROOM, "@claude long task");
      const turn = service.poll("claude", claude, true);
      if (turn.status !== "turn") throw new Error("expected a turn");
      return turn.turn_id;
    };

    it("warns after two missed check-ins without stopping the turn", () => {
      const turnId = startTurn();
      const started = now;
      now += 2 * 2 * 60_000 + 60_000;
      expect(card()?.turn_quiet_since).toBeNull();
      now += 1;
      service.tick();
      expect(card()?.state).toBe("working");
      expect(card()?.turn_quiet_since).toBe(started);
      expect(events()).not.toContain("contact_lost");
      expect(
        db.prepare("SELECT state FROM turns WHERE id = ?").get(turnId),
      ).toEqual({ state: "active" });
    });

    it("clears the warning when a long operation reports progress", () => {
      startTurn();
      now += 6 * 60_000;
      expect(card()?.turn_quiet_since).not.toBeNull();
      service.reportStatus("claude", claude, "working", "Still building");
      expect(card()?.turn_quiet_since).toBeNull();
      now += 4 * 60_000;
      expect(card()?.turn_quiet_since).toBeNull();
    });

    it("lets a recovered agent finish its turn normally", () => {
      const turnId = startTurn();
      now += 10 * 60_000;
      expect(card()?.turn_quiet_since).not.toBeNull();
      service.postAgentMessage("claude", claude, turnId, "Done");
      expect(card()?.state).not.toBe("working");
      expect(card()?.turn_quiet_since).toBeNull();
    });
  });
});
