import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";
import { buildApp } from "../../src/server/api/app.js";
import { RoleLibrary } from "../../src/server/domain/roles.js";
import { SkillLibrary } from "../../src/server/domain/skills.js";

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

describe("team role reassignment invariants", () => {
  it("mixes swaps, removal and reviewed library assignment in one transaction", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new KonfabService(db, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      for (const id of ["a", "b", "c", "d", "e", "f"])
        service.ensureAgent(id, id.toUpperCase());
      const room = service.createRoom("mixed", "", [
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
      ]);
      const roles = new RoleLibrary(db);
      roles.seedBuiltins("src/server/roles/builtin");
      const pack = roles.list()[0] as { id: string; revision_id: string };
      roles.assign(room.id, "a", pack.id, pack.revision_id, "Moves with pack");
      for (const id of ["b", "d", "e"])
        service.setMemberRole(room.id, id, {
          role: `Role ${id}`,
          can_edit: id === "b",
          base_role_revision: 0,
        });
      service.reassignRoles(room.id, [
        { agent_id: "a", from_agent_id: "b", base_revision: 1 },
        { agent_id: "b", from_agent_id: "a", base_revision: 1 },
        { agent_id: "c", from_agent_id: "d", base_revision: 0 },
        { agent_id: "d", from_agent_id: "c", base_revision: 1 },
        { agent_id: "e", none: true, base_revision: 1 },
        {
          agent_id: "f",
          role_id: pack.id,
          role_revision_id: pack.revision_id,
          notes: "New notes",
          base_revision: 0,
        },
      ]);
      const members = service.roomState(room.id).agents;
      expect(members.find((m) => m.id === "a")?.role).toBe("Role b");
      expect(members.find((m) => m.id === "b")?.can_edit).toBe(true);
      expect(members.find((m) => m.id === "a")?.can_edit).toBe(false);
      expect(members.find((m) => m.id === "c")?.role).toBe("Role d");
      expect(members.find((m) => m.id === "d")?.role).toBe("");
      expect(members.find((m) => m.id === "e")?.role).toBe("");
      expect(roles.assignment(room.id, "b")).toEqual(
        expect.objectContaining({ role_id: pack.id, notes: "Moves with pack" }),
      );
      expect(roles.assignment(room.id, "f")).toEqual(
        expect.objectContaining({ role_id: pack.id, notes: "New notes" }),
      );
    } finally {
      db.close();
    }
  });

  it("rolls back duplicate members, missing members, unreviewed roles and archived rooms", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-unreviewed-"));
    const db = openDatabase(":memory:");
    try {
      const service = new KonfabService(db, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      for (const id of ["a", "b", "c"]) service.ensureAgent(id, id);
      const room = service.createRoom("reject", "", ["a", "b"]);
      const skills = new SkillLibrary(db);
      const library = skills.registerLibrary("personal", root);
      const skill = skills.create(library, "example", "Example skill");
      const revision = skills.detail(skill).current_revision_id;
      db.prepare(
        "INSERT INTO role_libraries(id,kind,root_path) VALUES ('personal','personal',?)",
      ).run(join(root, "roles"));
      const roles = new RoleLibrary(db);
      const role = roles.createPersonal(
        "personal",
        "test-role",
        [
          {
            path: "ROLE.md",
            content: Buffer.from(
              "---\nname: test-role\ntitle: Test\ndescription: Test role\n---\nBody",
            ),
            mode: 0o600,
          },
        ],
        [{ skill_id: skill, revision_id: revision }],
      );
      const roleRevision = (
        roles.detail(role) as unknown as { revision_id: string }
      ).revision_id;
      const before = () =>
        JSON.stringify({
          members: db
            .prepare("SELECT * FROM room_members ORDER BY agent_id")
            .all(),
          assignments: db.prepare("SELECT * FROM room_member_roles").all(),
          messages: db.prepare("SELECT * FROM messages").all(),
          events: db.prepare("SELECT * FROM events").all(),
        });
      const baseline = before();
      expect(() =>
        service.reassignRoles(room.id, [
          { agent_id: "a", none: true, base_revision: 0 },
          { agent_id: "a", none: true, base_revision: 0 },
        ]),
      ).toThrow();
      expect(before()).toBe(baseline);
      expect(() =>
        service.reassignRoles(room.id, [
          { agent_id: "a", none: true, base_revision: 0 },
          { agent_id: "c", none: true, base_revision: 0 },
        ]),
      ).toThrow();
      expect(before()).toBe(baseline);
      expect(() =>
        service.reassignRoles(room.id, [
          { agent_id: "a", none: true, base_revision: 0 },
          {
            agent_id: "b",
            role_id: role,
            role_revision_id: roleRevision,
            base_revision: 0,
          },
        ]),
      ).toThrow("reviewed skill");
      expect(before()).toBe(baseline);
      service.archiveRoom(room.id);
      const archived = before();
      expect(() =>
        service.reassignRoles(room.id, [
          { agent_id: "a", none: true, base_revision: 0 },
        ]),
      ).toThrow("archived");
      expect(before()).toBe(archived);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat the system handover as a lead reply and delivers it to agents", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new KonfabService(db, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      service.ensureAgent("a", "A");
      service.ensureAgent("b", "B");
      const room = service.createRoom("system", "", ["a", "b"]);
      const session = service.join("a", "system").session_id;
      service.postUserMessage(room.id, "@a start");
      const turn = service.poll("a", session, true);
      if (turn.status !== "turn") throw new Error("missing turn");
      service.postAgentMessage(
        "a",
        session,
        turn.turn_id,
        "Waiting for continuation",
      );
      expect(service.roomState(room.id).routing.no_continuation).toBe(true);
      const count = (
        db.prepare("SELECT count(*) AS n FROM turns").get() as { n: number }
      ).n;
      service.reassignRoles(room.id, [
        { agent_id: "a", from_agent_id: "b", base_revision: 0 },
        { agent_id: "b", from_agent_id: "a", base_revision: 0 },
      ]);
      expect(service.roomState(room.id).routing.no_continuation).toBe(true);
      expect(
        (db.prepare("SELECT count(*) AS n FROM turns").get() as { n: number })
          .n,
      ).toBe(count);
      service.postUserMessage(room.id, "@a next");
      const next = service.poll("a", session, true);
      if (next.status !== "turn") throw new Error("missing turn");
      expect(next.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sender_type: "system",
            sender_id: "system",
            mentions: [],
          }),
        ]),
      );
      expect(service.exportRoom(room.id).markdown).toContain("## System (");
    } finally {
      db.close();
    }
  });
});
