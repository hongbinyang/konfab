import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate, openDatabase } from "../../src/server/db/index.js";
import {
  KonfabService,
  type WaitResult,
} from "../../src/server/domain/service.js";
import { RoleLibrary } from "../../src/server/domain/roles.js";
import { buildApp } from "../../src/server/api/app.js";

function asTurn(result: WaitResult) {
  if (result.status !== "turn")
    throw new Error(`Expected turn, got ${result.status}`);
  return result;
}

describe("role transition notice", () => {
  it("delivers first, custom-to-pack, notes and removal notices once across replacement and restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "role-notice-"));
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
      service.ensureAgent("a", "A");
      const room = service.createRoom("team", "", ["a"]);
      let session = service.join("a", "team").session_id;
      const next = () => {
        service.postUserMessage(room.id, "@a next");
        return asTurn(service.poll("a", session, true));
      };
      const finish = (turn: ReturnType<typeof asTurn>) =>
        service.passTurn("a", session, turn.turn_id);
      let turn = next();
      expect(turn.role).toBeNull();
      finish(turn);
      service.setMemberRole(room.id, "a", {
        role: "Custom instructions",
        can_edit: false,
        base_role_revision: 0,
      });
      turn = next();
      expect(turn.role).toEqual(
        expect.objectContaining({
          changed: true,
          notice: expect.stringContaining("assigned the role custom role"),
        }),
      );
      expect(turn.role).not.toEqual(
        expect.objectContaining({
          notice: expect.stringContaining("hand over"),
        }),
      );
      expect(asTurn(service.poll("a", session, true)).role).toEqual(turn.role);
      session = service.join("a", "team").session_id;
      turn = asTurn(service.poll("a", session, true));
      expect(turn.role).toEqual(
        expect.objectContaining({
          notice: expect.stringContaining("assigned the role"),
        }),
      );
      finish(turn);
      turn = next();
      expect(turn.role).toBeNull();
      let roles = new RoleLibrary(db);
      roles.seedBuiltins("src/server/roles/builtin");
      const pack = roles.list()[0] as {
        id: string;
        revision_id: string;
        title: string;
      };
      roles.assign(room.id, "a", pack.id, pack.revision_id, "First notes", 1);
      expect(asTurn(service.poll("a", session, true)).rules).toContain(
        "Custom instructions",
      );
      expect(service.readAssignedRole("a", session)).toBeNull();
      finish(turn);
      turn = next();
      expect(turn.role).toEqual(
        expect.objectContaining({
          changed: true,
          role_md: expect.any(String),
          notice: expect.stringContaining("changed from custom role"),
        }),
      );
      finish(turn);
      roles.assign(room.id, "a", pack.id, pack.revision_id, "Updated notes", 2);
      const app = await buildApp({ service, port: 19790 });
      await app.ready();
      await app.close();
      db.close();
      db = openDatabase(path);
      service = makeService();
      const reopenedApp = await buildApp({ service, port: 19790 });
      await reopenedApp.ready();
      roles = new RoleLibrary(db);
      turn = next();
      expect(turn.role).toEqual(
        expect.objectContaining({
          notice: expect.stringContaining("room notes"),
        }),
      );
      expect(turn.role).toEqual(
        expect.objectContaining({
          notice: expect.stringContaining("Updated notes"),
        }),
      );
      expect(turn.role).not.toEqual(
        expect.objectContaining({
          notice: expect.stringContaining("hand over"),
        }),
      );
      finish(turn);
      turn = next();
      expect(turn.role).toEqual(expect.objectContaining({ changed: false }));
      finish(turn);
      service.setMemberRole(room.id, "a", {
        role: "",
        can_edit: false,
        base_role_revision: 3,
      });
      turn = next();
      expect(turn.role).toEqual(
        expect.objectContaining({
          changed: true,
          removed: true,
          notice: expect.stringContaining("was removed"),
        }),
      );
      finish(turn);
      turn = next();
      expect(turn.role).toBeNull();
      finish(turn);
      await reopenedApp.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("baselines existing roles during migration without a spurious notice", () => {
    const db = new Database(":memory:");
    try {
      migrate(db, 24);
      const service = new KonfabService(db, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      service.ensureAgent("a", "A");
      const room = service.createRoom("upgrade", "", ["a"]);
      service.setMemberRole(room.id, "a", {
        role: "Existing instructions",
        can_edit: false,
        base_role_revision: 0,
      });
      migrate(db);
      const session = service.join("a", "upgrade").session_id;
      service.postUserMessage(room.id, "@a next");
      const turn = asTurn(service.poll("a", session, true));
      expect(turn.rules).toContain("Existing instructions");
      expect(turn.role).toBeNull();
    } finally {
      db.close();
    }
  });

  it("keeps old instructions and file access until an active editor change finishes", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new KonfabService(db, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      service.ensureAgent("a", "A");
      const room = service.createRoom("editor", "", ["a"]);
      const roles = new RoleLibrary(db);
      roles.seedBuiltins("src/server/roles/builtin");
      const pack = roles.list()[0] as { id: string; revision_id: string };
      roles.assign(room.id, "a", pack.id, pack.revision_id, "Old", 0);
      const session = service.join("a", "editor").session_id;
      service.postUserMessage(room.id, "@a work");
      const turn = asTurn(service.poll("a", session, true));
      service.setMemberRole(room.id, "a", {
        role: "New instructions",
        can_edit: false,
        base_role_revision: 1,
      });
      expect(asTurn(service.poll("a", session, true)).role).toEqual(turn.role);
      expect(service.readAssignedRole("a", session)).toEqual(
        expect.objectContaining({ revision_id: pack.revision_id }),
      );
      expect(
        service.readAssignedRoleFile(
          "a",
          session,
          pack.revision_id,
          "ROLE.md",
          0,
          100,
        ),
      ).toBeTruthy();
      service.passTurn("a", session, turn.turn_id);
      service.postUserMessage(room.id, "@a next");
      const next = asTurn(service.poll("a", session, true));
      expect(next.rules).toContain("New instructions");
      expect(next.role).toEqual(
        expect.objectContaining({
          notice: expect.stringContaining("custom role"),
        }),
      );
    } finally {
      db.close();
    }
  });
});
