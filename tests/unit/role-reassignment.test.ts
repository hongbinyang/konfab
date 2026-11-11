import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";
import { buildApp } from "../../src/server/api/app.js";
import { RoleLibrary } from "../../src/server/domain/roles.js";

describe("role reassignment", () => {
  it("atomically rotates roles, rejects stale changes, and preserves an active role across reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "konfab-rotation-"));
    const path = join(dir, "db.sqlite");
    let db = openDatabase(path);
    const makeService = () =>
      new KonfabService(db, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
    let service = makeService();
    try {
      for (const id of ["a", "b", "c"])
        service.ensureAgent(id, id.toUpperCase());
      const room = service.createRoom("team", "", ["a", "b", "c"]);
      const roles = new RoleLibrary(db);
      roles.seedBuiltins("src/server/roles/builtin");
      const pack = roles.list()[0] as { id: string; revision_id: string };
      roles.assign(room.id, "a", pack.id, pack.revision_id, "Pack notes");
      service.setMemberRole(room.id, "b", {
        role: "Custom instructions",
        can_edit: true,
        base_role_revision: 0,
      });
      const session = service.join("a", "team").session_id;
      service.postUserMessage("team", "@a start");
      const turn = service.poll("a", session, true);
      expect(turn.status).toBe("turn");
      const changes = [
        { agent_id: "a", from_agent_id: "b", base_revision: 1 },
        { agent_id: "b", from_agent_id: "c", base_revision: 1 },
        { agent_id: "c", from_agent_id: "a", base_revision: 0 },
      ];
      expect(() =>
        service.reassignRoles(
          room.id,
          changes.map((c, i) => (i ? c : { ...c, base_revision: 0 })),
        ),
      ).toThrow("changed since");
      const turnsBefore = (
        db.prepare("SELECT count(*) AS n FROM turns").get() as { n: number }
      ).n;
      service.reassignRoles(room.id, changes);
      expect(
        (db.prepare("SELECT count(*) AS n FROM turns").get() as { n: number })
          .n,
      ).toBe(turnsBefore);
      const system = db
        .prepare("SELECT mentions FROM messages WHERE sender_id='system'")
        .get() as { mentions: string };
      expect(JSON.parse(system.mentions)).toEqual([]);
      expect(service.exportRoom(room.id).markdown).toContain("## System (");
      expect(
        service
          .roomState(room.id)
          .agents.map(({ id, role, can_edit }) => ({ id, role, can_edit })),
      ).toEqual([
        expect.objectContaining({
          id: "a",
          role: "Custom instructions",
          can_edit: false,
        }),
        expect.objectContaining({ id: "b", role: "", can_edit: true }),
        expect.objectContaining({
          id: "c",
          role: expect.any(String),
          can_edit: false,
        }),
      ]);
      expect(roles.assignment(room.id, "c")).toEqual(
        expect.objectContaining({ role_id: pack.id, notes: "Pack notes" }),
      );
      expect(service.readAssignedRole("a", session)).toEqual(
        expect.objectContaining({
          revision_id: pack.revision_id,
          notes: "Pack notes",
        }),
      );
      expect(
        service.readAssignedRoleFile(
          "a",
          session,
          pack.revision_id,
          "ROLE.md",
          0,
          1024,
        ),
      ).toBeTruthy();
      expect(service.roomState(room.id).messages.at(-1)?.sender_type).toBe(
        "system",
      );
      const count = db
        .prepare(
          "SELECT count(*) AS n FROM events WHERE type='role_changed' AND json_extract(payload, '$.kind')='swap'",
        )
        .get() as { n: number };
      expect(count.n).toBe(3);
      const app = await buildApp({ service, port: 19789 });
      await app.ready();
      await app.close();
      db.close();
      db = openDatabase(path);
      service = makeService();
      const reopenedApp = await buildApp({ service, port: 19789 });
      await reopenedApp.ready();
      expect(service.readAssignedRole("a", session)).toEqual(
        expect.objectContaining({ revision_id: pack.revision_id }),
      );
      const replay = service.poll("a", session, true);
      expect(replay.status).toBe("turn");
      if (replay.status !== "turn") throw new Error("turn missing");
      service.passTurn("a", session, replay.turn_id);
      service.postUserMessage("team", "@a next");
      const next = service.poll("a", session, true);
      expect(next.status).toBe("turn");
      if (next.status !== "turn") throw new Error("turn missing");
      expect(next.rules).toContain("Custom instructions");
      expect(service.readAssignedRole("a", session)).toBeNull();
      expect(() =>
        service.readAssignedRoleFile(
          "a",
          session,
          pack.revision_id,
          "ROLE.md",
          0,
          1024,
        ),
      ).toThrow();
      expect(() => service.reassignRoles(room.id, changes)).toThrow(
        "changed since",
      );
      service.reassignRoles(room.id, [
        {
          agent_id: "a",
          role_id: pack.id,
          role_revision_id: pack.revision_id,
          notes: "Chosen",
          base_revision: 2,
        },
        { agent_id: "b", none: true, base_revision: 2 },
      ]);
      expect(new RoleLibrary(db).assignment(room.id, "a")).toEqual(
        expect.objectContaining({ role_id: pack.id, notes: "Chosen" }),
      );
      expect(new RoleLibrary(db).assignment(room.id, "b").assigned).toBe(false);

      await reopenedApp.close();
      expect(() =>
        service.reassignRoles(room.id, [
          { agent_id: "a", from_agent_id: "a", base_revision: 2 },
          { agent_id: "b", from_agent_id: "b", base_revision: 2 },
        ]),
      ).toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
