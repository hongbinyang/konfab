import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/index.js";
import {
  KonfabService,
  type WaitResult,
} from "../../src/server/domain/service.js";
import { buildApp } from "../../src/server/api/app.js";

const options = {
  waitTimeoutSeconds: 1,
  turnTimeoutMs: 60000,
  maxMessageChars: 10000,
};
function turn(result: WaitResult) {
  if (result.status !== "turn")
    throw new Error(`Expected turn: ${result.status}`);
  return result;
}

describe("structured formats", () => {
  it("runs review steps once, preserves queued messages and proposes the final summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-format-")),
      path = join(root, "db");
    let db = openDatabase(path);
    let service = new KonfabService(db, options);
    try {
      for (const id of ["a", "b", "c"]) service.ensureAgent(id, id);
      const room = service.createRoom("review", "", ["a", "b", "c"]);
      const sessions = Object.fromEntries(
        ["a", "b", "c"].map((id) => [
          id,
          service.join(id, "review").session_id,
        ]),
      );
      service.postUserMessage(room.id, "@c ordinary work");
      service.startFormat(room.id, {
        kind: "review",
        topic: "Branch 123",
        rounds: 1,
        author: "a",
        reviewers: ["b"],
      });
      expect(service.roomState(room.id).routing.queued[0]?.agent_id).toBe("a");
      expect(service.poll("c", sessions.c!, true).status).toBe("idle");
      let current = turn(service.poll("a", sessions.a!, true));
      expect(current.format).toMatchObject({
        slot: "author introduction",
        round: 1,
      });
      service.postUserMessage(room.id, "@a Lead interruption");
      service.postAgentMessage(
        "a",
        sessions.a!,
        current.turn_id,
        "Here is the change",
        { kind: "agent", agent_id: "c" },
      );
      expect(service.roomState(room.id).format?.current_step).toBe(1);
      service.postAgentMessage(
        "a",
        sessions.a!,
        current.turn_id,
        "Here is the change",
        { kind: "agent", agent_id: "c" },
      );
      expect(service.roomState(room.id).format?.current_step).toBe(1);
      const app = await buildApp({ service, port: 19793 });
      await app.ready();
      await app.close();
      db.close();
      db = openDatabase(path);
      service = new KonfabService(db, options);
      const reopened = await buildApp({ service, port: 19793 });
      await reopened.ready();
      current = turn(service.poll("b", sessions.b!, true));
      expect(current.format).toMatchObject({
        slot: "reviewer",
        instruction: expect.stringContaining("approve / request changes"),
      });
      service.postAgentMessage(
        "b",
        sessions.b!,
        current.turn_id,
        "Request changes in file X",
      );
      current = turn(service.poll("a", sessions.a!, true));
      expect(current.format?.slot).toBe("author response");
      service.passTurn("a", sessions.a!, current.turn_id);
      current = turn(service.poll("a", sessions.a!, true));
      expect(current.format?.slot).toBe("author summary");
      service.postAgentMessage(
        "a",
        sessions.a!,
        current.turn_id,
        "Final review summary",
      );
      expect(service.roomState(room.id).format).toBeNull();
      expect(service.decisions(room.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            proposer: "a",
            status: "proposed",
            body: "Final review summary",
          }),
        ]),
      );
      expect(service.poll("c", sessions.c!, true).status).toBe("turn");
      await reopened.close();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs two debate rounds in order and ends safely if a participant is removed", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new KonfabService(db, options);
      for (const id of ["a", "b", "c"]) service.ensureAgent(id, id);
      const room = service.createRoom("rounds", "", ["a", "b", "c"]);
      const sessions = Object.fromEntries(
        ["a", "b", "c"].map((id) => [
          id,
          service.join(id, "rounds").session_id,
        ]),
      );
      service.startFormat(room.id, {
        kind: "debate",
        topic: "Choice",
        rounds: 2,
        pro: "a",
        con: "b",
        judge: "c",
      });
      for (const [id, slot, round] of [
        ["a", "pro", 1],
        ["b", "con", 1],
        ["a", "pro", 2],
        ["b", "con", 2],
        ["c", "judge verdict", 2],
      ] as const) {
        const current = turn(service.poll(id, sessions[id]!, true));
        expect(current.format).toMatchObject({ slot, round, rounds: 2 });
        service.postAgentMessage(
          id,
          sessions[id]!,
          current.turn_id,
          `${slot} round ${round}`,
        );
      }
      expect(service.decisions(room.id)).toEqual([
        expect.objectContaining({
          proposer: "c",
          status: "proposed",
          body: "judge verdict round 2",
        }),
      ]);
      service.startFormat(room.id, {
        kind: "debate",
        topic: "Again",
        rounds: 1,
        pro: "a",
        con: "b",
        judge: "c",
      });
      service.setMembers(room.id, ["a", "c"]);
      expect(service.roomState(room.id).format).toBeNull();
      expect(service.roomState(room.id).messages.at(-1)?.body).toContain(
        "participant was removed",
      );
    } finally {
      db.close();
    }
  });

  it("keeps ordinary rejoin state separate from a paused format step", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new KonfabService(db, options);
      service.ensureAgent("a", "A");
      service.ensureAgent("b", "B");
      const room = service.createRoom("paused", "", ["a", "b"]);
      service.setMemberRole(room.id, "a", {
        role: "Custom",
        can_edit: false,
        base_role_revision: 0,
      });
      const old = service.join("a", "paused").session_id;
      service.startFormat(room.id, {
        kind: "review",
        topic: "Topic",
        rounds: 1,
        author: "a",
        reviewers: ["b"],
      });
      service.controlFormat(room.id, "pause");
      service.postUserMessage(room.id, "@a ordinary");
      const ordinary = turn(service.poll("a", old, true));
      expect(ordinary.format).toBeUndefined();
      expect(ordinary.role).toEqual(
        expect.objectContaining({ notice: expect.any(String) }),
      );
      service.join("a", "paused");
      const queued = db
        .prepare(
          "SELECT role_envelope_json FROM turns WHERE format_run_id IS NOT NULL AND state='queued'",
        )
        .get() as { role_envelope_json: string | null };
      expect(queued.role_envelope_json).toBeNull();
    } finally {
      db.close();
    }
  });

  it("pauses, resumes, skips, rejoins and ends a debate without inventing a verdict", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new KonfabService(db, options);
      for (const id of ["a", "b", "c"]) service.ensureAgent(id, id);
      const room = service.createRoom("debate", "", ["a", "b", "c"]);
      let a = service.join("a", "debate").session_id;
      const b = service.join("b", "debate").session_id,
        c = service.join("c", "debate").session_id;
      expect(() =>
        service.startFormat(room.id, {
          kind: "debate",
          topic: "X",
          rounds: 1,
          pro: "a",
          con: "a",
          judge: "c",
        }),
      ).toThrow("distinct");
      service.startFormat(room.id, {
        kind: "debate",
        topic: "X",
        rounds: 1,
        pro: "a",
        con: "b",
        judge: "c",
      });
      let first = turn(service.poll("a", a, true));
      service.controlFormat(room.id, "pause");
      service.postAgentMessage("a", a, first.turn_id, "Opening");
      expect(service.poll("b", b, true).status).toBe("idle");
      service.controlFormat(room.id, "resume");
      const second = turn(service.poll("b", b, true));
      service.controlFormat(room.id, "skip");
      expect(() =>
        service.postAgentMessage("b", b, second.turn_id, "late"),
      ).toThrow();
      const verdict = turn(service.poll("c", c, true));
      service.passTurn("c", c, verdict.turn_id);
      expect(service.roomState(room.id).format).toBeNull();
      expect(service.decisions(room.id)).toHaveLength(0);
      service.startFormat(room.id, {
        kind: "debate",
        topic: "Y",
        rounds: 1,
        pro: "a",
        con: "b",
        judge: "c",
      });
      first = turn(service.poll("a", a, true));
      a = service.join("a", "debate").session_id;
      const replay = turn(service.poll("a", a, true));
      expect(replay.format?.slot).toBe("pro");
      expect(replay.turn_id).not.toBe(first.turn_id);
      service.controlFormat(room.id, "end");
      service.postAgentMessage(
        "a",
        a,
        replay.turn_id,
        "Finished ordinary turn",
        { kind: "done" },
      );
      expect(service.roomState(room.id).format).toBeNull();
    } finally {
      db.close();
    }
  });
});
