import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";
import { buildApp } from "../../src/server/api/app.js";

const options = {
  waitTimeoutSeconds: 1,
  turnTimeoutMs: 60000,
  maxMessageChars: 1000,
  maxAgentsPerApp: 2,
};

describe("multi-agent apps", () => {
  it("migrates old credentials and sessions without reconfiguration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "multi-upgrade-"));
    const path = join(dir, "db.sqlite");
    let db = new Database(path);
    migrate(db, 25);
    db.prepare(
      "INSERT INTO agents(id,display_name,token_hash,created_at) VALUES (?,?,?,?)",
    ).run(
      "app",
      "App",
      createHash("sha256").update("existing-token").digest("hex"),
      1,
    );
    db.prepare(
      "INSERT INTO rooms(id,name,topic,created_at) VALUES (1,'team','',1)",
    ).run();
    db.prepare(
      "INSERT INTO room_members(room_id,agent_id,position) VALUES (1,'app',0)",
    ).run();
    db.prepare(
      "INSERT INTO sessions(id,room_id,agent_id,state,started_at,last_call_at) VALUES ('old',1,'app','active',1,1)",
    ).run();
    db.close();
    db = openDatabase(path);
    try {
      let service = new KonfabService(db, options);
      expect(service.authenticateAgent("existing-token")).toBe("app");
      expect(service.appAgent("app")).toBe("app");
      expect(service.sessionAgent("app", "old")).toBe("app");
      const app = await buildApp({ service, port: 19791 });
      await app.ready();
      await app.close();
      db.close();
      db = openDatabase(path);
      service = new KonfabService(db, options);
      const reopened = await buildApp({ service, port: 19791 });
      await reopened.ready();
      expect(service.authenticateAgent("existing-token")).toBe("app");
      expect(service.sessionAgent("app", "old")).toBe("app");
      await reopened.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces the limit and preserves identity and history when renaming or removing", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new KonfabService(db, options);
      service.ensureAgent("app", "App");
      const room = service.createRoom("team", "", ["app"]);
      service.addAppAgent("app", "app-dev", "Dev", room.id);
      expect(
        service.roomState(room.id).agents.map((agent) => agent.id),
      ).toContain("app-dev");
      expect(
        service
          .roomState(room.id)
          .agents.find((agent) => agent.id === "app-dev")?.join_prompt,
      ).toContain('as="app-dev"');
      expect(() => service.addAppAgent("app", "app-qa", "QA")).toThrow("limit");
      service.renameAppAgent("app-dev", "Builder");
      expect(
        service.overview().agents.find((agent) => agent.id === "app-dev")
          ?.display_name,
      ).toBe("Builder");
      const session = service.join("app-dev", "team").session_id;
      service.postUserMessage(room.id, "@app-dev work");
      const turn = service.poll("app-dev", session, true);
      if (turn.status !== "turn") throw new Error("missing turn");
      service.postAgentMessage(
        "app-dev",
        session,
        turn.turn_id,
        "A historical reply",
      );
      expect(() => service.archiveAppAgent("app-dev")).toThrow(
        "active sessions",
      );
      expect(() => service.archiveAppAgent("app")).toThrow("default agent");
      service.setMembers(room.id, ["app"]);
      service.archiveAppAgent("app-dev");
      expect(
        service.overview().agents.some((agent) => agent.id === "app-dev"),
      ).toBe(false);
      expect(
        service
          .roomState(room.id)
          .messages.some((message) => message.sender_id === "app-dev"),
      ).toBe(true);
      expect(() => service.appAgent("app", "app-dev")).toThrow();
      service.addAppAgent("app", "app-qa", "QA", room.id);
    } finally {
      db.close();
    }
  });
});
