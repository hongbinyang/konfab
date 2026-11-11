import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/index.js";
import { RoleLibrary } from "../../src/server/domain/roles.js";
import { KonfabService } from "../../src/server/domain/service.js";

describe("custom role conversion", () => {
  it("rejects grouping different stored text and leaves both members untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-convert-exact-"));
    const db = openDatabase(":memory:");
    try {
      const service = new KonfabService(db, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      service.ensureAgent("one", "One");
      service.ensureAgent("two", "Two");
      const room = service.createRoom("room", "", ["one", "two"]);
      service.setMemberRole(room.id, "one", { role: "Same", can_edit: false });
      service.setMemberRole(room.id, "two", { role: "Same", can_edit: false });
      db.prepare(
        "UPDATE room_members SET role = ? WHERE room_id = ? AND agent_id = ?",
      ).run("Same ", room.id, "two");
      db.prepare(
        "INSERT INTO role_libraries(id,kind,root_path) VALUES ('personal','personal',?)",
      ).run(join(root, "roles"));
      const roles = new RoleLibrary(db);
      expect(() =>
        roles.convertCustom([
          {
            name: "same",
            title: "Same",
            description: "Same",
            text: "Same",
            assign: true,
            members: [
              { room_id: room.id, agent_id: "one", revision: 1 },
              { room_id: room.id, agent_id: "two", revision: 1 },
            ],
          },
        ]),
      ).toThrow("changed");
      expect(roles.list()).toHaveLength(0);
      expect(roles.customAssignments()).toHaveLength(2);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("groups exact text, rolls back stale selections, and reverts after reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-convert-"));
    const path = join(root, "db");
    let db = openDatabase(path);
    try {
      const service = new KonfabService(db, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      service.ensureAgent("one", "One");
      service.ensureAgent("two", "Two");
      const room = service.createRoom("room", "", ["one", "two"]);
      const original = "Review carefully.\nKeep this text exactly.\n";
      service.setMemberRole(room.id, "one", { role: original, can_edit: true });
      service.setMemberRole(room.id, "two", {
        role: original,
        can_edit: false,
      });
      // Existing custom-role editing trims its input; conversion preserves stored bytes.
      const stored = original.trim();
      db.prepare(
        "INSERT INTO role_libraries(id,kind,root_path) VALUES ('personal','personal',?)",
      ).run(join(root, "roles"));
      const roles = new RoleLibrary(db);
      const group = {
        name: "shared-role",
        title: "Shared",
        description: "Review carefully.",
        text: stored,
        assign: true,
        members: [
          { room_id: room.id, agent_id: "one", revision: 1 },
          { room_id: room.id, agent_id: "two", revision: 1 },
        ],
      };
      expect(() =>
        roles.convertCustom([
          {
            ...group,
            members: [group.members[0]!, { ...group.members[1]!, revision: 0 }],
          },
        ]),
      ).toThrow("changed");
      expect(roles.list()).toHaveLength(0);
      expect(roles.customAssignments()).toHaveLength(2);
      const converted = roles.convertCustom([group]);
      expect(converted.roles).toHaveLength(1);
      expect(converted.pending).toHaveLength(0);
      expect(
        readFileSync(
          join(root, "roles", "shared-role", "ROLE.md"),
          "utf8",
        ).endsWith(stored),
      ).toBe(true);
      expect(roles.customAssignments()).toHaveLength(0);
      db.close();
      db = openDatabase(path);
      const reopened = new RoleLibrary(db);
      expect(() => reopened.revertConversion(room.id, "one", 1)).toThrow(
        "changed",
      );
      reopened.revertConversion(room.id, "one", 2);
      expect(reopened.customAssignments()).toEqual([
        expect.objectContaining({ agent_id: "one", text: stored }),
      ]);
      expect(reopened.assignment(room.id, "two")).toEqual(
        expect.objectContaining({ assigned: true }),
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
