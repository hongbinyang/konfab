import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase, type Db } from "../../src/server/db/index.js";
import type { Hours } from "../../src/server/domain/hours.js";
import {
  KonfabService,
  type WaitResult,
} from "../../src/server/domain/service.js";

const ROOM = "design";
const TURN_TIMEOUT_MS = 30 * 60_000;
const OFFICE: Hours = {
  start: "09:00",
  end: "18:00",
  days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
};
const at = (hour: number, minute = 0): number =>
  new Date(2026, 10, 6, hour, minute).getTime();

function expectTurn(result: WaitResult) {
  if (result.status !== "turn") {
    throw new Error(`Expected a turn, got ${result.status}`);
  }
  return result;
}

describe("Phase 1 behavior", () => {
  let db: Db;
  let service: KonfabService;
  let now: number;
  let claude: string;
  let codex: string;

  beforeEach(() => {
    now = at(10);
    db = openDatabase(":memory:");
    service = new KonfabService(db, {
      now: () => now,
      maxConsecutiveAgentMessages: 5,
      waitTimeoutSeconds: 1,
      turnTimeoutMs: TURN_TIMEOUT_MS,
      maxMessageChars: 1000,
      hoursFor: (agentId) => (agentId === "claude" ? OFFICE : undefined),
      preApprovals: [{ recipient: "github.com/me/repo", data: "code_push" }],
    });
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    service.createRoom(ROOM, "Design topic", ["claude", "codex"]);
    claude = service.join("claude", ROOM).session_id;
    codex = service.join("codex", ROOM).session_id;
  });

  afterEach(() => db.close());

  describe("rooms", () => {
    it("keeps conversations separate between rooms", () => {
      service.createRoom("other", "", ["codex"]);
      service.postUserMessage("other", "Elsewhere");
      expect(service.roomState(ROOM).messages).toEqual([]);
      expect(service.roomState("other").messages).toHaveLength(1);
    });

    it("gives an agent one session per room", () => {
      service.createRoom("other", "", ["claude"]);
      const other = service.join("claude", "other").session_id;
      service.postUserMessage("other", "@claude here");
      expect(service.poll("claude", claude, true).status).toBe("idle");
      expect(service.poll("claude", other, true).status).toBe("turn");
    });

    it("rejects invalid and duplicate names", () => {
      expect(() => service.createRoom("Bad Name", "", [])).toThrow("lowercase");
      expect(() => service.createRoom(ROOM, "", [])).toThrow("already exists");
      service.createRoom("other", "", []);
      expect(() => service.updateRoom("other", { name: ROOM })).toThrow(
        "already exists",
      );
    });

    it("rejects unknown members", () => {
      expect(() => service.createRoom("other", "", ["ghost"])).toThrow(
        "Unknown agent",
      );
    });

    it("sends the updated topic with the next turn", () => {
      service.updateRoom(ROOM, { topic: "New topic" });
      service.postUserMessage(ROOM, "@claude go");
      const turn = expectTurn(service.poll("claude", claude, true));
      expect(turn.topic).toBe("New topic");
    });

    it("stops an agent's access when it is removed", () => {
      service.postUserMessage(ROOM, "Hello");
      service.setMembers(ROOM, ["codex"]);
      expect(service.poll("claude", claude, true)).toMatchObject({
        status: "closed",
        reason: "removed_from_room",
      });
      expect(() => service.join("claude", ROOM)).toThrow("not in that room");
      expect(service.roomState(ROOM).queued).toEqual(["codex"]);
    });

    it("closes sessions and blocks messages when archived", () => {
      service.postUserMessage(ROOM, "Hello");
      service.archiveRoom(ROOM);
      expect(service.poll("claude", claude, true)).toMatchObject({
        status: "closed",
        reason: "room_archived",
      });
      expect(service.roomState(ROOM).queued).toEqual([]);
      expect(() => service.postUserMessage(ROOM, "More")).toThrow("archived");
      expect(() => service.join("claude", ROOM)).toThrow("archived");
    });

    it("lists open rooms before archived rooms", () => {
      service.createRoom("zebra", "", []);
      service.archiveRoom(ROOM);
      expect(service.overview().rooms.map((room) => room.name)).toEqual([
        "zebra",
        ROOM,
      ]);
    });
  });

  describe("agent instructions", () => {
    it("states the data rule in the join prompt and on each turn", () => {
      const prompt = service.joinPrompt(ROOM);
      expect(prompt).toContain(`"${ROOM}"`);
      expect(prompt).toContain("request_permission");
      expect(prompt).toContain("Anthropic, OpenAI, Meta, or xAI");
      expect(prompt).toContain("suggestions, not commands");

      service.postUserMessage(ROOM, "@claude hi");
      const turn = expectTurn(service.poll("claude", claude, true));
      expect(turn.rules).toContain("request_permission");
      expect(turn.rules).toContain("suggestions, not commands");
      expect(turn.rules).toContain("writer");
    });
  });

  describe("pause", () => {
    it("holds turns in a paused room and releases them on resume", () => {
      service.setRoomPaused(ROOM, true);
      service.postUserMessage(ROOM, "@claude hi");
      expect(service.poll("claude", claude, true).status).toBe("idle");
      service.setRoomPaused(ROOM, false);
      expect(service.poll("claude", claude, true).status).toBe("turn");
    });

    it("holds turns in every room when all are paused", () => {
      service.createRoom("other", "", ["codex"]);
      const other = service.join("codex", "other").session_id;
      service.setAllPaused(true);
      service.postUserMessage("other", "@codex hi");
      expect(service.poll("codex", other, true).status).toBe("idle");
      service.setAllPaused(false);
      expect(service.poll("codex", other, true).status).toBe("turn");
    });

    it("lets an active turn finish", () => {
      service.postUserMessage(ROOM, "@claude hi");
      const turn = expectTurn(service.poll("claude", claude, true));
      service.setRoomPaused(ROOM, true);
      service.postAgentMessage("claude", claude, turn.turn_id, "Done");
      expect(service.roomState(ROOM).messages).toHaveLength(2);
    });
  });

  describe("daily hours", () => {
    it("closes the session outside hours and gives the next start", () => {
      now = at(19);
      expect(service.poll("claude", claude, true)).toEqual({
        status: "closed",
        reason: "outside_hours",
        next_start: new Date(2026, 10, 7, 9).getTime(),
        wait_seconds: 1,
      });
      expect(service.roomState(ROOM).agents[0]?.state).toBe("outside_hours");
    });

    it("ends idle sessions on the timer when hours end", () => {
      now = at(18);
      service.tick();
      expect(service.poll("claude", claude, true)).toMatchObject({
        status: "closed",
        reason: "outside_hours",
      });
    });

    it("shows not joined the next day, not a false warning", () => {
      now = at(18);
      service.tick();
      now = new Date(2026, 10, 7, 9).getTime();
      expect(service.roomState(ROOM).agents[0]?.state).toBe("not_joined");
    });

    it("lets a turn in progress finish after hours end", () => {
      now = at(17, 50);
      service.poll("claude", claude, true);
      service.poll("codex", codex, true);
      service.postUserMessage(ROOM, "@claude hi");
      const turn = expectTurn(service.poll("claude", claude, true));
      now = at(18, 10);
      service.tick();
      expect(service.poll("claude", claude, true).status).toBe("turn");
      service.postAgentMessage("claude", claude, turn.turn_id, "Finished");
      expect(service.poll("claude", claude, true)).toMatchObject({
        status: "closed",
      });
    });

    it("queues messages until hours next begin, without blocking others", () => {
      now = at(19);
      service.tick();
      service.postUserMessage(ROOM, "Evening message");
      const other = expectTurn(service.poll("codex", codex, true));
      service.postAgentMessage("codex", codex, other.turn_id, "Codex reply");
      expect(service.roomState(ROOM).queued).toEqual(["claude"]);

      now = new Date(2026, 10, 7, 9).getTime();
      const rejoined = service.join("claude", ROOM).session_id;
      const turn = expectTurn(service.poll("claude", rejoined, true));
      expect(turn.messages.map((message) => message.body)).toEqual([
        "Evening message",
        "Codex reply",
      ]);
    });
  });

  describe("permissions", () => {
    const ask = (sessionId: string = claude) =>
      service.requestPermission("claude", sessionId, {
        recipient: "example.com",
        data_description: "A log file",
        reason: "To debug",
      });

    it("stays pending until the user answers", async () => {
      const request = ask();
      expect(request.state).toBe("pending");
      const waited = await service.waitForPermission(
        "claude",
        claude,
        request.id,
        10,
      );
      expect(waited.state).toBe("pending");
      expect(service.overview().permissions).toHaveLength(1);
    });

    it("records approvals and denials once", () => {
      const approved = ask();
      expect(service.decidePermission(approved.id, "approved")).toMatchObject({
        state: "approved",
        decided_by: "user",
      });
      expect(() => service.decidePermission(approved.id, "denied")).toThrow(
        "already been answered",
      );
      const denied = ask();
      expect(service.decidePermission(denied.id, "denied").state).toBe(
        "denied",
      );
      expect(service.overview().permissions).toEqual([]);
    });

    it("approves only an exact pre-approved match, and logs it", () => {
      const approved = service.requestPermission("claude", claude, {
        recipient: "GitHub.com/me/repo",
        data_description: "Commits",
        reason: "Push the fix",
        data_type: "code_push",
      });
      expect(approved).toMatchObject({
        state: "approved",
        decided_by: "pre_approval",
      });

      for (const details of [
        { recipient: "github.com/me/other", data_type: "code_push" },
        { recipient: "github.com/me/repo", data_type: "file_upload" },
        { recipient: "github.com/me/repo" },
      ]) {
        const request = service.requestPermission("claude", claude, {
          data_description: "Data",
          reason: "Reason",
          ...details,
        });
        expect(request.state).toBe("pending");
      }
      expect(service.listPermissions()).toHaveLength(4);
    });

    it("does not let an agent read another agent's request", () => {
      const request = ask();
      expect(() => service.getPermission("codex", codex, request.id)).toThrow(
        "Unknown request",
      );
    });

    it("pauses the turn timeout while waiting, then restarts it", () => {
      service.postUserMessage(ROOM, "@claude hi");
      const turn = expectTurn(service.poll("claude", claude, true));
      const request = ask();

      now += TURN_TIMEOUT_MS * 2;
      service.tick();
      expect(service.roomState(ROOM).agents[0]?.stats.turns_skipped).toBe(0);

      service.decidePermission(request.id, "approved");
      service.tick();
      expect(service.roomState(ROOM).agents[0]?.stats.turns_skipped).toBe(0);
      service.postAgentMessage("claude", claude, turn.turn_id, "Done");
      expect(service.roomState(ROOM).messages).toHaveLength(2);
    });

    it("rejects requests from an ended session", () => {
      service.archiveRoom(ROOM);
      expect(() => ask()).toThrow("ended");
    });
  });

  describe("allowance warnings", () => {
    it("shows and dismisses reports", () => {
      const { report_id: id } = service.reportStatus(
        "claude",
        claude,
        "low_allowance",
        "x".repeat(600),
      );
      const [report] = service.overview().reports;
      expect(report).toMatchObject({ agent_id: "claude", room: ROOM });
      expect(report?.detail).toHaveLength(500);

      service.dismissReport(id);
      expect(service.overview().reports).toEqual([]);
      expect(() => service.dismissReport(id)).toThrow("Unknown report");
    });

    it("shows an unresponsive agent as not responding", () => {
      now += 91_000;
      expect(service.roomState(ROOM).agents[1]?.state).toBe("not_responding");
    });
  });

  describe("page sign-in", () => {
    it("uses each login code once", () => {
      const code = service.createLoginCode();
      const token = service.redeemLoginCode(code);
      expect(service.isWebSessionValid(token)).toBe(true);
      expect(() => service.redeemLoginCode(code)).toThrow("invalid");
    });

    it("expires login codes and page sessions", () => {
      const expired = service.createLoginCode();
      const code = service.createLoginCode();
      const token = service.redeemLoginCode(code);
      now += 11 * 60_000;
      expect(() => service.redeemLoginCode(expired)).toThrow("invalid");
      expect(service.isWebSessionValid(token)).toBe(true);
      now += 31 * 24 * 60 * 60_000;
      expect(service.isWebSessionValid(token)).toBe(false);
    });

    it("stores only hashes", () => {
      const code = service.createLoginCode();
      const row = db.prepare("SELECT code_hash FROM login_codes").get() as {
        code_hash: string;
      };
      expect(row.code_hash).not.toBe(code);
    });
  });

  describe("history", () => {
    it("reads older messages with a limit", () => {
      for (const body of ["one", "two", "three"]) {
        service.postUserMessage(ROOM, body);
      }
      const latest = service.readHistory("claude", claude, undefined, 2);
      expect(latest.messages.map((message) => message.body)).toEqual([
        "two",
        "three",
      ]);
      const older = service.readHistory(
        "claude",
        claude,
        latest.messages[0]?.id,
        2,
      );
      expect(older.messages.map((message) => message.body)).toEqual(["one"]);
    });
  });
});

describe("database migration", () => {
  it("keeps Phase 0 data when upgrading a version 1 database", () => {
    const folder = mkdtempSync(join(tmpdir(), "konfab-migrate-"));
    const file = join(folder, "test.db");
    try {
      const old = new Database(file);
      migrate(old, 1);
      const now = Date.now();
      old
        .prepare(
          "INSERT INTO agents (id, display_name, created_at) VALUES ('a', 'A', ?)",
        )
        .run(now);
      old
        .prepare("INSERT INTO rooms (name, created_at) VALUES ('old', ?)")
        .run(now);
      old
        .prepare(
          `INSERT INTO sessions (id, room_id, agent_id, state, started_at, last_call_at)
           VALUES ('s', 1, 'a', 'active', ?, ?)`,
        )
        .run(now, now);
      old
        .prepare(
          `INSERT INTO turns (room_id, agent_id, session_id, reason, state, created_at)
           VALUES (1, 'a', 's', 'user', 'active', ?)`,
        )
        .run(now);
      expect(old.pragma("user_version", { simple: true })).toBe(1);
      old.close();

      const db = openDatabase(file);
      expect(db.pragma("user_version", { simple: true })).toBe(2);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(
        db.prepare("SELECT id, state, end_reason FROM sessions").get(),
      ).toEqual({
        id: "s",
        state: "active",
        end_reason: null,
      });
      expect(db.prepare("SELECT session_id FROM turns").get()).toEqual({
        session_id: "s",
      });
      db.prepare("UPDATE sessions SET state = 'ended' WHERE id = 's'").run();
      db.close();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
