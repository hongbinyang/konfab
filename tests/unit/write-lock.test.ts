import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";
import { buildApp } from "../../src/server/api/app.js";

describe("advisory write locks", () => {
  it("normalizes keys globally, limits ownership and cleans up leases across reopen and replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-lock-"));
    const dbPath = join(root, "db");
    symlinkSync(root, join(root, "alias"));
    let now = 1_000_000;
    let db = openDatabase(dbPath);
    const makeService = () =>
      new KonfabService(db, {
        now: () => now,
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
    let service = makeService();
    try {
      for (const id of ["a", "b", "c"]) service.ensureAgent(id, id);
      const first = service.createRoom("one", "", ["a", "c"]),
        second = service.createRoom("two", "", ["b"]);
      service.setMemberEdit(first.id, "a", true);
      service.setMemberEdit(second.id, "b", true);
      const a = service.join("a", "one").session_id,
        b = service.join("b", "two").session_id,
        c = service.join("c", "one").session_id;
      const key = `repo:${root}#main`,
        alias = `repo:${root}/alias/#main`;
      expect(service.acquireLock("c", c, key, "coordinate").granted).toBe(true);
      expect(service.releaseLock("c", c, key).released).toBe(true);
      service.join("c", "one");
      expect(() => service.acquireLock("c", c, key, "stale session")).toThrow(
        "newer conversation",
      );
      expect(service.acquireLock("a", a, alias, "merge").granted).toBe(true);
      const denied = service.acquireLock("b", b, key, "push");
      expect(denied.granted).toBe(false);
      expect(denied.lock).toEqual(
        expect.objectContaining({
          agent_id: "a",
          resource: `repo:${realpathSync(root)}#main`,
          purpose: "merge",
        }),
      );
      expect(denied.lock).not.toHaveProperty("session_id");
      expect(() => service.releaseLock("b", b, key)).toThrow("holding session");
      expect(service.acquireLock("a", a, key, "renew", 240).granted).toBe(true);
      expect(() => service.acquireLock("a", a, key, "too long", 241)).toThrow();
      const app = await buildApp({ service, port: 19792 });
      await app.ready();
      await app.close();
      db.close();
      db = openDatabase(dbPath);
      service = makeService();
      const reopened = await buildApp({ service, port: 19792 });
      await reopened.ready();
      expect(service.acquireLock("b", b, key, "still held").granted).toBe(
        false,
      );
      now += 240 * 60000 + 1;
      service.tick();
      expect(service.acquireLock("b", b, key, "new owner").granted).toBe(true);
      expect(
        service.acquireLock("a", a, `repo:${root}#Main`, "other branch")
          .granted,
      ).toBe(true);
      service.join("a", "one");
      expect(service.roomState(first.id).locks).toHaveLength(0);
      service.forceReleaseLock(second.id, key);
      expect(service.roomState(second.id).messages.at(-1)?.sender_type).toBe(
        "system",
      );
      expect(service.activity(second.id).map((event) => event.type)).toContain(
        "lock_force_released",
      );
      expect(service.acquireLock("b", b, key, "again").granted).toBe(true);
      service.archiveRoom(second.id);
      expect(service.roomState(second.id).locks).toHaveLength(0);
      await reopened.close();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
