import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/server/db/index.js";
import { buildApp } from "../../src/server/api/app.js";
import { KonfabService } from "../../src/server/domain/service.js";
import {
  deleteRoomRows,
  roomDeletionCounts,
  cleanupRoomFiles,
  compactRoomDatabase,
} from "../../src/server/domain/room-deletion.js";

const options = (root: string) => ({
  waitTimeoutSeconds: 1,
  turnTimeoutMs: 30_000,
  maxMessageChars: 1000,
  attachmentDir: root,
});

describe("permanent room deletion", () => {
  it("removes room rows and attachments while preserving other rooms and shared data", () => {
    const dir = mkdtempSync(join(tmpdir(), "konfab-delete-"));
    const root = join(dir, "files");
    const db = openDatabase(join(dir, "db"));
    try {
      const service = new KonfabService(db, options(root));
      service.ensureAgent("worker", "Worker");
      const one = service.createRoom("delete-me", "", ["worker"]).id;
      const two = service.createRoom("keep-me", "", ["worker"]).id;
      const session = service.join("worker", "delete-me").session_id;
      const message = service.postUserMessage(one, "example").message_id;
      const turn = service.poll("worker", session, true);
      if (turn.status !== "turn") throw new Error("expected turn");
      db.prepare(
        "INSERT INTO observed_waits(session_id,call_id,started_at) VALUES (?, 'call', 0)",
      ).run(session);
      const decision = db
        .prepare(
          "INSERT INTO decisions(room_id,proposer,status,created_at,updated_at) VALUES (?,'user','confirmed',0,0)",
        )
        .run(one);
      db.prepare(
        "INSERT INTO decision_versions(decision_id,version,body,created_at) VALUES (?,1,'private',0)",
      ).run(decision.lastInsertRowid);
      db.prepare(
        "INSERT INTO handoffs(source_message_id,target_agent_id,turn_id) VALUES (?, 'worker', ?)",
      ).run(message, turn.turn_id);
      const receipt = db.prepare(
        "INSERT INTO bridge_receipts(agent_id,request_key,payload,result,created_at) VALUES ('worker',?,?,?,0)",
      );
      receipt.run(
        "delete-receipt",
        JSON.stringify({ path: "/agent/join", body: { room: "old-name" } }),
        JSON.stringify({ session_id: session }),
      );
      receipt.run(
        "keep-receipt",
        JSON.stringify({ path: "/agent/join", body: { room: "keep-me" } }),
        JSON.stringify({ session_id: "unrelated" }),
      );
      service.uploadAttachment(one, "example.txt", Buffer.from("test"));
      service.postUserMessage(two, "keep");
      expect(() => service.deleteRoom(one, "delete-me")).toThrow(/Archive/);
      service.archiveRoom(one);
      expect(() => service.deleteRoom(one, "wrong")).toThrow(/name/);
      const result = service.deleteRoom(one, "delete-me");
      expect(result.files_removed).toBe(true);
      expect(existsSync(join(root, String(one)))).toBe(false);
      expect(service.roomState(two).messages[0]?.body).toBe("keep");
      expect(
        db.prepare("SELECT 1 FROM agents WHERE id='worker'").get(),
      ).toBeDefined();
      expect(
        db
          .prepare("SELECT 1 FROM observed_waits WHERE session_id=?")
          .get(session),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT 1 FROM decision_versions").get(),
      ).toBeUndefined();
      expect(db.prepare("SELECT 1 FROM handoffs").get()).toBeUndefined();
      expect(
        db.prepare("SELECT request_key FROM bridge_receipts").all(),
      ).toEqual([{ request_key: "keep-receipt" }]);
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string }[];
      for (const { name } of tables) {
        if (name === "pending_room_cleanup") continue;
        const columns = db.pragma(`table_info(${name})`) as { name: string }[];
        if (columns.some((column) => column.name === "room_id"))
          expect(
            db
              .prepare(`SELECT count(*) AS n FROM ${name} WHERE room_id=?`)
              .get(one),
            name,
          ).toEqual({ n: 0 });
      }
      expect(
        db
          .prepare(
            "SELECT type FROM events WHERE type='room_deleted' AND room_id IS NULL",
          )
          .get(),
      ).toEqual({ type: "room_deleted" });
      const next = service.createRoom("later", "", []).id;
      expect(next).toBeGreaterThan(two);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers a pending deletion after reopening without touching unknown folders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "konfab-delete-"));
    const root = join(dir, "files");
    const path = join(dir, "db");
    let db = openDatabase(path);
    try {
      let service = new KonfabService(db, options(root));
      const id = service.createRoom("test", "", []).id;
      mkdirSync(join(root, String(id)), { recursive: true });
      mkdirSync(join(root, "unknown"));
      writeFileSync(join(root, String(id), "file"), "test");
      service.archiveRoom(id);
      deleteRoomRows(db, id, "test", roomDeletionCounts(db, id), Date.now());
      const firstApp = await buildApp({ service, port: 19798 });
      await firstApp.ready();
      await firstApp.close();
      db.close();
      db = openDatabase(path);
      service = new KonfabService(db, options(root));
      service.recoverDeletedRooms();
      const reopenedApp = await buildApp({ service, port: 19798 });
      await reopenedApp.ready();
      await reopenedApp.close();
      expect(existsSync(join(root, String(id)))).toBe(false);
      expect(existsSync(join(root, "unknown"))).toBe(true);
      expect(
        db.prepare("SELECT 1 FROM pending_room_cleanup").get(),
      ).toBeUndefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never reuses a deleted room ID when its attachment cleanup is pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "konfab-delete-"));
    const root = join(dir, "files");
    const target = join(dir, "outside");
    mkdirSync(root);
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "private");
    const db = openDatabase(join(dir, "db"));
    try {
      const service = new KonfabService(db, options(root));
      const id = service.createRoom("old", "", []).id;
      symlinkSync(target, join(root, String(id)));
      service.archiveRoom(id);
      expect(service.deleteRoom(id, "old").files_removed).toBe(false);
      const next = service.createRoom("new", "", []).id;
      expect(next).toBeGreaterThan(id);
      expect(
        db
          .prepare("SELECT 1 FROM pending_room_cleanup WHERE room_id=?")
          .get(id),
      ).toBeDefined();
      expect(existsSync(join(target, "keep"))).toBe(true);
      expect(existsSync(join(root, String(next)))).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains a compaction retry marker if vacuum fails", () => {
    const db = openDatabase(":memory:");
    try {
      db.prepare(
        "INSERT INTO settings(key,value) VALUES ('room_delete_vacuum_pending','1')",
      ).run();
      const exec = vi.spyOn(db, "exec").mockImplementation(() => {
        throw new Error("busy");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(compactRoomDatabase(db)).toBe(false);
      expect(
        db
          .prepare(
            "SELECT 1 FROM settings WHERE key='room_delete_vacuum_pending'",
          )
          .get(),
      ).toBeDefined();
      exec.mockRestore();
      warn.mockRestore();
      expect(compactRoomDatabase(db)).toBe(true);
      expect(
        db
          .prepare(
            "SELECT 1 FROM settings WHERE key='room_delete_vacuum_pending'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses symlinked room folders and retains the retry marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "konfab-delete-"));
    const root = join(dir, "files");
    const target = join(dir, "outside");
    mkdirSync(root);
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "test");
    const db = openDatabase(":memory:");
    try {
      db.prepare(
        "INSERT INTO pending_room_cleanup(room_id,created_at) VALUES (42,0)",
      ).run();
      symlinkSync(target, join(root, "42"));
      expect(cleanupRoomFiles(db, root, 42)).toBe(false);
      expect(existsSync(join(target, "keep"))).toBe(true);
      expect(
        db.prepare("SELECT 1 FROM pending_room_cleanup WHERE room_id=42").get(),
      ).toBeDefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
