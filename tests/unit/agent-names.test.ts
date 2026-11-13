import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type Db } from "../../src/server/db/index.js";
import { buildApp } from "../../src/server/api/app.js";
import {
  KonfabService,
  type WaitResult,
} from "../../src/server/domain/service.js";
import {
  mentionConflict,
  normalizeMentionTokens,
  roomNameProblem,
} from "../../src/server/domain/agent-names.js";

const ROOM = "named";

function expectTurn(result: WaitResult) {
  if (result.status !== "turn")
    throw new Error(`Expected a turn, got ${result.status}`);
  return result;
}

describe("room name rules", () => {
  it("accepts mention syntax and rejects other names", () => {
    expect(roomNameProblem("A")).toBeNull();
    expect(roomNameProblem("Reviewer-2_b")).toBeNull();
    expect(roomNameProblem("a".repeat(32))).toBeNull();
    for (const bad of ["", "2a", "-a", "a b", "a.b", "🤖", "a".repeat(33)])
      expect(roomNameProblem(bad)?.code).toBe("name_invalid");
    expect(roomNameProblem("Lead")?.code).toBe("name_reserved");
    expect(roomNameProblem("ALL")?.code).toBe("name_reserved");
  });

  it("finds names that one mention would reach twice", () => {
    const claude = { id: "claude", name: "A", label: "A" };
    const codex = { id: "codex", name: null, label: "Codex" };
    expect(mentionConflict([claude, codex])).toBeNull();
    expect(mentionConflict([claude, { ...codex, name: "a" }])?.token).toBe("a");
    expect(mentionConflict([{ ...claude, name: "Codex" }, codex])?.token).toBe(
      "codex",
    );
    // An agent's own ID is a valid name for it.
    expect(mentionConflict([{ ...claude, name: "Claude" }, codex])).toBeNull();
  });

  it("maps names before IDs and keeps reserved and unknown tokens", () => {
    const members = [
      { id: "claude", name: "A" },
      { id: "codex", name: null },
    ];
    expect(
      normalizeMentionTokens(["a", "codex", "all", "lead", "zed"], members),
    ).toEqual(["claude", "codex", "all", "lead", "zed"]);
    expect(normalizeMentionTokens(["a", "claude"], members)).toEqual([
      "claude",
    ]);
  });
});

describe("room names for agents", () => {
  let db: Db;
  let service: KonfabService;
  let now: number;

  const create = () =>
    new KonfabService(db, {
      now: () => now,
      waitTimeoutSeconds: 50,
      turnTimeoutMs: 30 * 60_000,
      maxMessageChars: 1000,
    });

  beforeEach(() => {
    now = 1_000_000;
    db = openDatabase(":memory:");
    service = create();
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    service.ensureAgent("gemini", "Gemini");
    service.createRoom(ROOM, "Topic", ["claude", "codex"]);
  });

  afterEach(() => db.close());

  const nameBoth = () => {
    service.setRoomName(ROOM, "claude", "A");
    service.setRoomName(ROOM, "codex", "B");
  };

  it("routes lead mentions by name, in any case, and keeps ID aliases", () => {
    nameBoth();
    const claude = service.join("claude", ROOM).session_id;
    const codex = service.join("codex", ROOM).session_id;
    const posted = service.postUserMessage(ROOM, "@a please start");
    expect(posted.message_id).toBeGreaterThan(0);
    expect(service.poll("claude", claude, true).status).toBe("turn");
    expect(service.poll("codex", codex, true).status).not.toBe("turn");
    const stored = db
      .prepare("SELECT mentions, mentioned FROM messages WHERE id = ?")
      .get(posted.message_id) as { mentions: string; mentioned: string };
    expect(JSON.parse(stored.mentions)).toEqual(["claude"]);
    expect(JSON.parse(stored.mentioned)).toEqual(["claude"]);

    const state = service.roomState(ROOM);
    const message = state.messages.find((m) => m.id === posted.message_id);
    expect(message?.mentions).toEqual(["claude"]);
  });

  it("still routes an ID mention when names are set", () => {
    nameBoth();
    service.join("claude", ROOM);
    const codex = service.join("codex", ROOM).session_id;
    service.postUserMessage(ROOM, "@CODEX over to you");
    expect(service.poll("codex", codex, true).status).toBe("turn");
  });

  it("hands off by name in a mention, a next action and hand_off", () => {
    nameBoth();
    const claude = service.join("claude", ROOM).session_id;
    const codex = service.join("codex", ROOM).session_id;
    service.postUserMessage(ROOM, "@A start");
    const turn = expectTurn(service.poll("claude", claude, true));
    service.postAgentMessage(
      "claude",
      claude,
      turn.turn_id,
      "Done, @b review",
      {
        kind: "agent",
        agent_id: "B",
      },
    );
    const review = expectTurn(service.poll("codex", codex, true));
    const posted = db
      .prepare(
        "SELECT mentions, mentioned, continuation_json FROM messages WHERE sender_id = 'claude'",
      )
      .get() as {
      mentions: string;
      mentioned: string;
      continuation_json: string | null;
    };
    expect(JSON.parse(posted.mentions)).toEqual(["codex"]);
    expect(JSON.parse(posted.mentioned)).toEqual(["codex"]);
    if (posted.continuation_json)
      expect(posted.continuation_json).not.toContain('"B"');

    const reply = service.postAgentMessage(
      "codex",
      codex,
      review.turn_id,
      "Reviewed.",
    );
    const handed = service.handOff("codex", codex, reply.message_id, "a");
    expect(handed.to).toBe("claude");
  });

  it("gives agents member names and a members rule", () => {
    nameBoth();
    const joined = service.join("claude", ROOM);
    expect(joined.member_names).toEqual([
      { id: "claude", name: "A" },
      { id: "codex", name: "B" },
    ]);
    expect(joined.rules).toContain(
      "Members: @A (claude), @B (codex). Mention members by these names; agent IDs also work.",
    );
    service.postUserMessage(ROOM, "hello");
    const turn = expectTurn(service.poll("claude", joined.session_id, true));
    expect(turn.member_names).toEqual(joined.member_names);
  });

  it("leaves rules unchanged in rooms without names", () => {
    const joined = service.join("claude", ROOM);
    expect(joined.rules).not.toContain("Members:");
    expect(joined.member_names).toEqual([
      { id: "claude", name: "claude" },
      { id: "codex", name: "codex" },
    ]);
  });

  it("rejects reserved, invalid and ambiguous names", () => {
    expect(() => service.setRoomName(ROOM, "claude", "all")).toThrow(
      expect.objectContaining({ code: "name_reserved" }),
    );
    expect(() => service.setRoomName(ROOM, "claude", "a b")).toThrow(
      expect.objectContaining({ code: "name_invalid" }),
    );
    expect(() => service.setRoomName(ROOM, "claude", "Codex")).toThrow(
      expect.objectContaining({ code: "name_conflict" }),
    );
    service.setRoomName(ROOM, "claude", "A");
    expect(() => service.setRoomName(ROOM, "codex", "a")).toThrow(
      /@a would mean both A's name and Codex's name/,
    );
    service.setRoomName(ROOM, "claude", "Claude");
    expect(service.roomState(ROOM).room_names).toEqual({ claude: "Claude" });
  });

  it("fixes the name once the agent joins, and allows changes before", () => {
    service.setRoomName(ROOM, "claude", "A");
    service.setRoomName(ROOM, "claude", "Alpha");
    service.setRoomName(ROOM, "claude", null);
    service.setRoomName(ROOM, "claude", "A");
    service.join("claude", ROOM);
    expect(() => service.setRoomName(ROOM, "claude", "Z")).toThrow(
      expect.objectContaining({ code: "name_fixed" }),
    );
    expect(() => service.setRoomName(ROOM, "claude", null)).toThrow(
      expect.objectContaining({ code: "name_fixed" }),
    );
    const card = service
      .roomState(ROOM)
      .agents.find((agent) => agent.id === "claude");
    expect(card).toMatchObject({ room_name: "A", name_fixed: true });
    // Codex has not joined, so its name can still change.
    service.setRoomName(ROOM, "codex", "B");
  });

  it("only names members of an unarchived room and leaves other rooms alone", () => {
    service.createRoom("other", "", ["claude"]);
    service.setRoomName(ROOM, "claude", "A");
    expect(service.roomState("other").room_names).toEqual({});
    expect(() => service.setRoomName("other", "codex", "B")).toThrow(
      expect.objectContaining({ code: "agent_not_found" }),
    );
    service.archiveRoom(ROOM);
    expect(() => service.setRoomName(ROOM, "codex", "B")).toThrow(
      expect.objectContaining({ code: "room_archived" }),
    );
  });

  it("checks names when members are added, and keeps names of former members", () => {
    service.setRoomName(ROOM, "claude", "gemini");
    expect(() =>
      service.setMembers(ROOM, ["claude", "codex", "gemini"]),
    ).toThrow(expect.objectContaining({ code: "name_conflict" }));
    service.setRoomName(ROOM, "claude", "A");
    service.setMembers(ROOM, ["codex"]);
    // A former member's name can be reused...
    service.setRoomName(ROOM, "codex", "a");
    // ...and re-adding the former member is then rejected.
    expect(() => service.setMembers(ROOM, ["codex", "claude"])).toThrow(
      /@a would mean both/,
    );
    service.setRoomName(ROOM, "codex", "B");
    service.setMembers(ROOM, ["codex", "claude"]);
    expect(
      service.roomState(ROOM).agents.map((agent) => agent.room_name),
    ).toEqual(["B", "A"]);
  });

  it("names a new agent when it is added to the room", () => {
    const room = service.roomState(ROOM).room.id;
    service.addAppAgent("claude", "claude-two", "Second", room, undefined, "C");
    expect(service.roomState(ROOM).room_names["claude-two"]).toBe("C");
    expect(() =>
      service.addAppAgent(
        "claude",
        "claude-three",
        "Third",
        room,
        undefined,
        "c",
      ),
    ).toThrow(expect.objectContaining({ code: "name_conflict" }));
    // The failed add is rolled back.
    expect(
      db.prepare("SELECT 1 FROM agents WHERE id='claude-three'").get(),
    ).toBe(undefined);
    expect(() =>
      service.addAppAgent(
        "claude",
        "a-agent",
        "No room",
        undefined,
        undefined,
        "D",
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_agent" }));
  });

  it("keeps earlier recipients and the explicit mention list after names change", () => {
    service.setRoomName(ROOM, "claude", "A");
    service.join("codex", ROOM);
    const first = service.postUserMessage(ROOM, "@A first");
    service.setRoomName(ROOM, "claude", null);
    service.setRoomName(ROOM, "claude", "Z");
    const view = service
      .roomState(ROOM)
      .messages.find((m) => m.id === first.message_id);
    expect(view?.mentions).toEqual(["claude"]);
    expect(view?.body).toBe("@A first");
    // The old name no longer reaches anyone, and is kept as written.
    const second = service.postUserMessage(ROOM, "@a and @all");
    const row = db
      .prepare("SELECT mentions, mentioned FROM messages WHERE id = ?")
      .get(second.message_id) as { mentions: string; mentioned: string };
    expect(JSON.parse(row.mentioned)).toEqual(["a", "all"]);
    expect(JSON.parse(row.mentions)).toEqual(["claude", "codex"]);
    const plain = service.postUserMessage(ROOM, "no mentions");
    const plainRow = db
      .prepare("SELECT mentions, mentioned FROM messages WHERE id = ?")
      .get(plain.message_id) as { mentions: string; mentioned: string };
    expect(JSON.parse(plainRow.mentioned)).toEqual([]);
    expect(JSON.parse(plainRow.mentions)).toEqual(["claude", "codex"]);
  });

  it("reports an unreachable agent mentioned by name", () => {
    service.setRoomName(ROOM, "claude", "A");
    const posted = service.postUserMessage(ROOM, "@a are you there?");
    expect(posted.unreachable).toEqual([
      expect.objectContaining({ agent_id: "claude", state: "not_joined" }),
    ]);
  });

  it("queues a parallel turn for a mention by name", () => {
    service = new KonfabService(db, {
      now: () => now,
      waitTimeoutSeconds: 50,
      turnTimeoutMs: 30 * 60_000,
      maxMessageChars: 1000,
      parallelLeadMentions: true,
    });
    service.updateRoom(ROOM, { parallel_lead_mentions: true });
    nameBoth();
    const claude = service.join("claude", ROOM).session_id;
    const codex = service.join("codex", ROOM).session_id;
    service.postUserMessage(ROOM, "Begin work");
    expectTurn(service.poll("claude", claude, true));
    service.postUserMessage(ROOM, "@b respond");
    expect(
      expectTurn(service.poll("codex", codex, true)).parallel,
    ).toBeTruthy();
  });

  it("returns legacy mentions for messages stored before the migration", () => {
    const join = service.join("claude", ROOM);
    db.prepare(
      "INSERT INTO messages(room_id,sender_type,sender_id,body,mentions,created_at) VALUES (?,?,?,?,?,?)",
    ).run(
      service.roomState(ROOM).room.id,
      "user",
      "user",
      "@claude old @Nobody",
      '["claude"]',
      now,
    );
    const legacy = service
      .roomState(ROOM)
      .messages.find((m) => m.body === "@claude old @Nobody");
    expect(legacy?.mentions).toEqual(["claude", "nobody"]);
    expect(join.session_id).toBeTruthy();
  });
});

describe("room name persistence", () => {
  it("upgrades an existing database and keeps names across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "room-names-"));
    const path = join(dir, "db.sqlite");
    const options = {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60000,
      maxMessageChars: 1000,
    };
    try {
      let raw = new Database(path);
      migrate(raw, 31);
      raw.close();
      let db = openDatabase(path);
      let service = new KonfabService(db, options);
      service.ensureAgent("claude", "Claude");
      service.ensureAgent("codex", "Codex");
      service.createRoom(ROOM, "", ["claude", "codex"]);
      const old = service.postUserMessage(ROOM, "@codex before");
      db.prepare("UPDATE messages SET mentioned = NULL WHERE id = ?").run(
        old.message_id,
      );
      service.setRoomName(ROOM, "claude", "A");
      service.join("claude", ROOM);
      let app = await buildApp({ service, port: 19792 });
      await app.ready();
      await app.close();
      db.close();

      db = openDatabase(path);
      service = new KonfabService(db, options);
      app = await buildApp({ service, port: 19792 });
      await app.ready();
      const state = service.roomState(ROOM);
      expect(state.agents.find((a) => a.id === "claude")).toMatchObject({
        room_name: "A",
        name_fixed: true,
      });
      expect(state.agents.find((a) => a.id === "codex")).toMatchObject({
        room_name: null,
        name_fixed: false,
      });
      expect(
        state.messages.find((m) => m.id === old.message_id)?.mentions,
      ).toEqual(["codex"]);
      expect(() => service.setRoomName(ROOM, "claude", "B")).toThrow(
        expect.objectContaining({ code: "name_fixed" }),
      );
      const posted = service.postUserMessage(ROOM, "@A after restart");
      expect(
        JSON.parse(
          (
            db
              .prepare("SELECT mentions FROM messages WHERE id = ?")
              .get(posted.message_id) as { mentions: string }
          ).mentions,
        ),
      ).toEqual(["claude"]);
      await app.close();
      db.close();
      raw = new Database(path);
      expect(raw.pragma("user_version", { simple: true })).toBe(33);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
