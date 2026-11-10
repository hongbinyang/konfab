import { Writable } from "node:stream";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/api/app.js";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { SkillLibrary } from "../../src/server/domain/skills.js";
import { KonfabService } from "../../src/server/domain/service.js";

const PORT = 18788;
const HOST = `127.0.0.1:${PORT}`;

describe("page API", () => {
  let db: Db;
  let service: KonfabService;
  let app: FastifyInstance;
  let cookie: string;
  let attachmentDir: string;

  type Method = "GET" | "POST" | "PATCH" | "PUT";
  const call = (method: Method, url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { host: HOST, cookie },
      ...(payload ? { payload } : {}),
    });

  beforeEach(async () => {
    db = openDatabase(":memory:");
    attachmentDir = mkdtempSync(join(tmpdir(), "konfab-attachments-"));
    service = new KonfabService(db, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60_000,
      maxMessageChars: 1000,
      attachmentDir,
      maxAttachmentBytes: 1024,
    });
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    app = await buildApp({
      service,
      skills: new SkillLibrary(db),
      skillsHome: attachmentDir,
      port: PORT,
    });

    const login = await app.inject({
      method: "GET",
      url: `/login?code=${service.createLoginCode()}`,
      headers: { host: HOST },
    });
    cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(attachmentDir, { recursive: true, force: true });
  });

  it("creates and lists a local skill through authenticated page routes", async () => {
    const created = await call("POST", "/api/library/skills", {
      scope: "personal",
      name: "review-change",
      description: "Review a change",
    });
    expect(created.statusCode).toBe(200);
    const list = await call("GET", "/api/library?scope=personal");
    expect(list.statusCode).toBe(200);
    expect(list.json().skills).toHaveLength(1);
    const id = created.json().id as string;
    const detail = await call("GET", `/api/library/skills/${id}`);
    expect(detail.json().name).toBe("review-change");
    expect(detail.json().reviewed_at).toBeNull();
    const written = await call("PUT", `/api/library/skills/${id}/files`, {
      path: "SKILL.md",
      content_base64: Buffer.from(
        "---\nname: review-change\ndescription: Updated\n---\nBody",
      ).toString("base64"),
      base_revision_id: detail.json().current_revision_id,
      base_draft_hash: detail.json().draft_hash,
    });
    expect(written.statusCode).toBe(200);
    const conflict = await call("PUT", `/api/library/skills/${id}/files`, {
      path: "SKILL.md",
      content_base64: "WA==",
      base_revision_id: detail.json().current_revision_id,
      base_draft_hash: detail.json().draft_hash,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("draft_conflict");
    const invalid = await call("PUT", `/api/library/skills/${id}/files`, {
      path: "../escape",
      content_base64: "WA==",
      base_revision_id: detail.json().current_revision_id,
      base_draft_hash: written.json().draft_hash,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("invalid_path");
    const saved = await call("POST", `/api/library/skills/${id}/save`, {
      base_revision_id: detail.json().current_revision_id,
      base_draft_hash: written.json().draft_hash,
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (await call("GET", `/api/library/skills/${id}`)).json().description,
    ).toBe("Updated");
  });

  it("lets the lead disable automatic continuation", async () => {
    const created = await call("POST", "/api/rooms", {
      name: "auto-control",
      members: ["claude"],
    });
    const id = created.json().id;
    const updated = await call("PUT", `/api/rooms/${id}/auto-continue`, {
      enabled: false,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().routing.auto_continue_enabled).toBe(false);
    expect(
      (await call("GET", `/api/rooms/${id}`)).json().routing
        .auto_continue_enabled,
    ).toBe(false);
  });

  describe("sign-in", () => {
    it("sets a protected cookie and redirects", async () => {
      const login = await app.inject({
        method: "GET",
        url: `/login?code=${service.createLoginCode()}`,
        headers: { host: HOST },
      });
      expect(login.statusCode).toBe(303);
      expect(login.headers.location).toBe("/");
      const value = String(login.headers["set-cookie"]);
      expect(value).toContain("HttpOnly");
      expect(value).toContain("SameSite=Strict");
      expect(value).toContain("Path=/");
    });

    it("rejects a reused or invalid code", async () => {
      const code = service.createLoginCode();
      const request = {
        method: "GET" as const,
        url: `/login?code=${code}`,
        headers: { host: HOST },
      };
      expect((await app.inject(request)).statusCode).toBe(303);
      expect((await app.inject(request)).statusCode).toBe(401);
    });

    it("blocks page routes without a valid session", async () => {
      for (const headers of [
        { host: HOST },
        { host: HOST, cookie: "konfab_session=wrong" },
      ]) {
        for (const url of [
          "/api/overview",
          "/api/events",
          "/api/rooms/1",
          "/api/library?scope=personal",
        ]) {
          const response = await app.inject({ method: "GET", url, headers });
          expect(response.statusCode).toBe(401);
        }
      }
    });
  });

  describe("request protection", () => {
    it("rejects an untrusted host, even with a valid session", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/overview",
        headers: { host: "evil.test", cookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it("rejects an untrusted origin, even with a valid session", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: { host: HOST, cookie, origin: "https://evil.test" },
        payload: { name: "attack" },
      });
      expect(response.statusCode).toBe(403);
      expect(service.overview().rooms).toEqual([]);
    });

    it("sets a strict content security policy", async () => {
      const policy = (await call("GET", "/api/overview")).headers[
        "content-security-policy"
      ];
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("script-src 'self'");
      expect(policy).not.toContain("unsafe");
    });

    it("does not let an agent token use page routes", async () => {
      service.setAgentToken("claude", "agent-token");
      const response = await app.inject({
        method: "GET",
        url: "/api/overview",
        headers: { host: HOST, authorization: "Bearer agent-token" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("does not let a page session use agent routes", async () => {
      const response = await call("POST", "/agent/join", { room: "any" });
      expect(response.statusCode).toBe(401);
    });

    it("rejects invalid input", async () => {
      expect((await call("POST", "/api/rooms", {})).statusCode).toBe(400);
      expect((await call("GET", "/api/rooms/abc")).statusCode).toBe(400);
    });
  });

  describe("rooms", () => {
    const createRoom = async () => {
      const response = await call("POST", "/api/rooms", {
        name: "design",
        topic: "Topic",
        members: ["claude"],
      });
      expect(response.statusCode).toBe(201);
      return (response.json() as { id: number }).id;
    };

    it("creates, updates, and lists rooms", async () => {
      const id = await createRoom();
      const updated = await call("PATCH", `/api/rooms/${id}`, {
        name: "renamed",
        topic: "New topic",
      });
      expect(updated.json().room).toMatchObject({
        name: "renamed",
        topic: "New topic",
      });
      const overview = (await call("GET", "/api/overview")).json();
      expect(overview.rooms).toHaveLength(1);
      expect(overview.agents).toHaveLength(2);
    });

    it("rejects a duplicate room", async () => {
      await createRoom();
      const response = await call("POST", "/api/rooms", { name: "design" });
      expect(response.statusCode).toBe(409);
    });

    it("returns 404 for an unknown room", async () => {
      expect((await call("GET", "/api/rooms/999")).statusCode).toBe(404);
    });

    it("changes members, pauses, posts, and archives", async () => {
      const id = await createRoom();
      const members = await call("PUT", `/api/rooms/${id}/members`, {
        members: ["claude", "codex"],
      });
      expect(members.json().agents).toHaveLength(2);

      await call("POST", `/api/rooms/${id}/pause`, { paused: true });
      expect((await call("GET", `/api/rooms/${id}`)).json().room.paused).toBe(
        true,
      );

      const posted = await call("POST", `/api/rooms/${id}/messages`, {
        body: "Hello",
      });
      expect(posted.statusCode).toBe(200);

      await call("POST", `/api/rooms/${id}/archive`);
      const blocked = await call("POST", `/api/rooms/${id}/messages`, {
        body: "More",
      });
      expect(blocked.statusCode).toBe(409);
    });

    it("pauses all rooms", async () => {
      await call("POST", "/api/pause-all", { paused: true });
      expect((await call("GET", "/api/overview")).json().paused_all).toBe(true);
    });

    it("answers a permission request and dismisses a report", async () => {
      await createRoom();
      const session = service.join("claude", "design").session_id;
      const request = service.requestPermission("claude", session, {
        recipient: "example.com",
        data_description: "Data",
        reason: "Reason",
      });
      const decided = await call(
        "POST",
        `/api/permissions/${request.id}/decision`,
        { decision: "denied" },
      );
      expect(decided.json().state).toBe("denied");

      const { report_id: reportId } = service.reportStatus(
        "claude",
        session,
        "other",
        "Note",
      );
      const dismissed = await call("POST", `/api/reports/${reportId}/dismiss`);
      expect(dismissed.statusCode).toBe(200);
    });
  });

  it("updates the room brief and an agent's role", async () => {
    const { id } = service.createRoom("team", "", ["claude", "codex"]);
    const brief = await call("PATCH", `/api/rooms/${id}`, {
      brief: "Ship it",
    });
    expect(brief.json().room.brief).toBe("Ship it");

    const role = await call("PUT", `/api/rooms/${id}/members/codex`, {
      role: "Implementer",
      can_edit: true,
    });
    expect(role.statusCode).toBe(200);
    expect(role.json().agents[1]).toMatchObject({
      id: "codex",
      role: "Implementer",
      can_edit: true,
    });

    const missing = await call("PUT", `/api/rooms/${id}/members/ghost`, {
      role: "",
      can_edit: false,
    });
    expect(missing.statusCode).toBe(403);
    const invalid = await call("PUT", `/api/rooms/${id}/members/codex`, {
      role: "x",
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("starts a break for one room or all rooms", async () => {
    const one = service.createRoom("one", "", ["claude"]);
    const two = service.createRoom("two", "", ["codex"]);
    const single = await call("POST", `/api/rooms/${one.id}/break`);
    expect(single.statusCode).toBe(200);
    expect(service.roomState(one.id).room.on_break).toBe(true);
    expect(service.roomState(two.id).room.on_break).toBe(false);

    const all = await call("POST", "/api/break-all");
    expect(all.statusCode).toBe(200);
    expect(service.roomState(two.id).room.on_break).toBe(true);
    const overview = (await call("GET", "/api/overview")).json();
    expect(overview.rooms.every((r: { on_break: boolean }) => r.on_break)).toBe(
      true,
    );
  });

  it("pages the complete permission history without crossing room boundaries", async () => {
    service.ensureAgent("worker", "Worker");
    const room = service.createRoom("history", "", ["worker"]);
    service.createRoom("other-history", "", ["worker"]);
    const session = service.join("worker", "history").session_id;
    const otherSession = service.join("worker", "other-history").session_id;
    for (let i = 0; i < 103; i += 1) {
      const item = service.requestPermission("worker", session, {
        recipient: "example.test",
        data_description: `item ${i}`,
        reason: "test",
      });
      service.decidePermission(item.id, i % 2 ? "approved" : "denied");
    }
    service.requestPermission("worker", otherSession, {
      recipient: "other.test",
      data_description: "other room",
      reason: "test",
    });
    const url = `/api/rooms/${room.id}/permissions`;
    expect(
      (await app.inject({ method: "GET", url, headers: { host: HOST } }))
        .statusCode,
    ).toBe(401);
    const first = (await call("GET", url)).json();
    expect(first.permissions).toHaveLength(50);
    const second = (
      await call("GET", `${url}?before_id=${first.next_before_id}`)
    ).json();
    expect(second.permissions).toHaveLength(50);
    const third = (
      await call("GET", `${url}?before_id=${second.next_before_id}`)
    ).json();
    expect(third.permissions).toHaveLength(3);
    expect(third.next_before_id).toBeNull();
    const all = [
      ...first.permissions,
      ...second.permissions,
      ...third.permissions,
    ] as { id: number; room_id: number }[];
    expect(new Set(all.map((item) => item.id)).size).toBe(103);
    expect(all.every((item) => item.room_id === room.id)).toBe(true);
    expect(all.map((item) => item.id)).toEqual(
      [...all.map((item) => item.id)].sort((a, b) => b - a),
    );
  });

  it("stores authenticated attachments, sends image-only messages and exposes local metadata", async () => {
    const room = service.createRoom("files", "", ["claude"]);
    const session = service.join("claude", "files").session_id;
    const uploadUrl = `/api/rooms/${room.id}/attachments?name=diagram.png`;
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
    ]);
    const denied = await app.inject({
      method: "POST",
      url: uploadUrl,
      headers: { host: HOST, "content-type": "application/octet-stream" },
      payload: png,
    });
    expect(denied.statusCode).toBe(401);
    const upload = await app.inject({
      method: "POST",
      url: uploadUrl,
      headers: {
        host: HOST,
        cookie,
        "content-type": "application/octet-stream",
      },
      payload: png,
    });
    expect(upload.statusCode).toBe(201);
    const attachment = upload.json();
    expect(attachment.media_type).toBe("image/png");
    expect(attachment.path).toMatch(/\.png$/);
    expect(existsSync(attachment.path)).toBe(true);
    const downloadUrl = `/api/rooms/${room.id}/attachments/${attachment.id}`;
    expect(
      (
        await app.inject({
          method: "GET",
          url: downloadUrl,
          headers: { host: HOST },
        })
      ).statusCode,
    ).toBe(401);
    const download = await call("GET", downloadUrl);
    expect(download.headers["content-disposition"]).toContain("attachment;");
    expect(download.rawPayload).toEqual(png);
    const inline = await call("GET", `${downloadUrl}?inline=1`);
    expect(inline.headers["content-disposition"]).toContain("inline;");
    expect(
      (
        await call("POST", `/api/rooms/${room.id}/messages`, {
          body: "",
          attachment_ids: [attachment.id],
        })
      ).statusCode,
    ).toBe(200);
    const result = service.poll("claude", session, true);
    expect(result.status).toBe("turn");
    if (result.status !== "turn") throw new Error("Expected turn");
    expect(result.messages[0]?.attachments?.[0]).toMatchObject({
      path: attachment.path,
      filename: "diagram.png",
      size: png.length,
    });
    expect(
      (await call("GET", `/api/rooms/${room.id}/search?q=diagram`)).json()
        .messages[0].attachments[0].id,
    ).toBe(attachment.id);
    expect((await call("GET", `/api/rooms/${room.id}/export`)).body).toContain(
      "[diagram.png](file://",
    );
    expect(
      (
        await call("POST", `/api/rooms/${room.id}/messages`, {
          body: "",
          attachment_ids: [attachment.id],
        })
      ).statusCode,
    ).toBe(400);
  });

  it("limits upload sizes and never serves SVG inline", async () => {
    const room = service.createRoom("safe-files", "", ["claude"]);
    const headers = {
      host: HOST,
      cookie,
      "content-type": "application/octet-stream",
    };
    const tooLarge = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/attachments?name=large`,
      headers,
      payload: Buffer.alloc(1025),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().message).toContain("size limit");
    const svg = await app.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/attachments?name=picture.svg`,
      headers,
      payload: Buffer.from("<svg onload=alert(1) />"),
    });
    const attachment = svg.json();
    expect(attachment.media_type).toBe("application/octet-stream");
    expect(attachment.path).toMatch(/\.svg$/);
    const response = await call(
      "GET",
      `/api/rooms/${room.id}/attachments/${attachment.id}?inline=1`,
    );
    expect(response.headers["content-disposition"]).toContain("attachment;");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/rooms/${room.id}/attachments/${attachment.id}`,
      headers: { host: HOST, cookie },
    });
    expect(deleted.statusCode).toBe(200);
    expect(existsSync(attachment.path)).toBe(false);
  });

  it("limits decision confirmation and revisions to the authenticated lead", async () => {
    const room = service.createRoom("decisions", "", ["claude"]);
    const joined = service.join("claude", "decisions");
    const proposed = service.proposeDecision(
      "claude",
      joined.session_id,
      "Deploy Monday",
      "one",
    );
    const url = `/api/rooms/${room.id}/decisions/${proposed.id}`;
    const unauthenticated = await app.inject({
      method: "POST",
      url,
      headers: { host: HOST },
      payload: { action: "confirm" },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect((await call("POST", url, { action: "confirm" })).json().status).toBe(
      "confirmed",
    );
    expect(
      (
        await call("POST", url, { action: "revise", body: "Deploy Tuesday" })
      ).json().version,
    ).toBe(2);
    const versions = (await call("GET", `${url}/versions`)).json().versions;
    expect(versions.map((v: { body: string }) => v.body)).toEqual([
      "Deploy Tuesday",
      "Deploy Monday",
    ]);
    const other = service.createRoom("other", "", ["codex"]);
    expect(
      (
        await call("POST", `/api/rooms/${other.id}/decisions/${proposed.id}`, {
          action: "retire",
        })
      ).statusCode,
    ).toBe(404);
  });

  it("shows and decides a room permission using the authenticated route", async () => {
    const room = service.createRoom("requests", "", ["claude"]);
    const joined = service.join("claude", "requests");
    const pending = service.requestPermission("claude", joined.session_id, {
      recipient: "example.com",
      data_description: "diagnostic",
      reason: "debug",
    });
    const state = (await call("GET", `/api/rooms/${room.id}`)).json();
    expect(state.permissions[0]).toMatchObject({
      id: pending.id,
      state: "pending",
      recipient: "example.com",
    });
    const unauthorized = await app.inject({
      method: "POST",
      url: `/api/permissions/${pending.id}/decision`,
      headers: { host: HOST },
      payload: { decision: "approved" },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(
      (
        await call("POST", `/api/permissions/${pending.id}/decision`, {
          decision: "approved",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await call("GET", `/api/rooms/${room.id}`)).json().permissions[0],
    ).toMatchObject({ state: "approved", decided_by: "user" });
  });

  it("paginates room activity without leaking other rooms", async () => {
    const one = service.createRoom("first", "", ["claude"]);
    const two = service.createRoom("second", "", ["codex"]);
    for (let i = 0; i < 205; i += 1) service.setRoomPaused(one.id, i % 2 === 0);
    service.join("codex", "second");
    const first = await call("GET", `/api/rooms/${one.id}/activity`);
    expect(first.statusCode).toBe(200);
    const events = first.json().events as {
      id: number;
      agent_id: string | null;
    }[];
    expect(events).toHaveLength(200);
    expect(events.some((event) => event.agent_id === "codex")).toBe(false);
    const older = await call(
      "GET",
      `/api/rooms/${one.id}/activity?before_id=${events.at(-1)!.id}`,
    );
    expect(older.json().events.length).toBe(5);
    expect(
      (await call("GET", `/api/rooms/${two.id}/activity`)).json().events,
    ).toHaveLength(2);
  });

  it("searches and exports a room", async () => {
    const { id } = service.createRoom("notes", "A topic", ["claude"]);
    service.postUserMessage(id, "Find this 100% 👍🏽 🎉");
    service.postUserMessage(id, "Other text");

    const search = await call("GET", `/api/rooms/${id}/search?q=100%25`);
    expect(search.json().messages).toHaveLength(1);
    const emojiSearch = await call(
      "GET",
      `/api/rooms/${id}/search?q=${encodeURIComponent("👍🏽")}`,
    );
    expect(emojiSearch.json().messages[0].body).toBe("Find this 100% 👍🏽 🎉");
    const empty = await call("GET", `/api/rooms/${id}/search?q=%20`);
    expect(empty.statusCode).toBe(400);

    const exported = await call("GET", `/api/rooms/${id}/export`);
    expect(exported.headers["content-disposition"]).toContain("notes.md");
    expect(exported.body).toContain("# notes");
    expect(exported.body).toContain("Find this 100% 👍🏽 🎉");
  });

  it("extends the selected session and rejects unknown members", async () => {
    service.ensureAgent("worker", "Worker");
    const room = service.createRoom("run-window", "", ["worker"]);
    service.join("worker", "run-window");
    const url = `/api/rooms/${room.id}/members/worker/extend-run`;
    const before = service.roomState(room.id).agents[0]!.closes_at!;
    expect((await call("POST", url, { minutes: 60 })).statusCode).toBe(200);
    expect(service.roomState(room.id).agents[0]?.closes_at).toBe(
      before + 60 * 60_000,
    );
    expect(
      (
        await call("POST", `/api/rooms/${room.id}/members/ghost/extend-run`, {
          minutes: 60,
        })
      ).statusCode,
    ).toBe(403);
    expect((await call("POST", url, { minutes: 5000 })).statusCode).toBe(400);
  });

  it("keeps sign-in codes and credentials out of the logs", async () => {
    const lines: string[] = [];
    const logged = await buildApp({
      service,
      port: PORT,
      logger: true,
      logStream: new Writable({
        write(chunk, _encoding, done) {
          lines.push(String(chunk));
          done();
        },
      }),
    });
    const code = service.createLoginCode();
    const login = await logged.inject({
      method: "GET",
      url: `/login?code=${code}`,
      headers: { host: HOST },
    });
    const sessionCookie =
      String(login.headers["set-cookie"]).split(";")[0] ?? "";
    await logged.inject({
      method: "GET",
      url: "/api/overview",
      headers: {
        host: HOST,
        cookie: sessionCookie,
        authorization: "Bearer secret-agent-token",
      },
    });
    await logged.close();

    const output = lines.join("");
    expect(output).toContain("/login");
    expect(output).not.toContain(code);
    expect(output).not.toContain("secret-agent-token");
    expect(output).not.toContain(sessionCookie.split("=")[1] ?? "missing");
  });

  it("pushes live updates over Server-Sent Events", async () => {
    await app.listen({ host: "127.0.0.1", port: PORT });
    const controller = new AbortController();
    const response = await fetch(`http://${HOST}/api/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let received = decoder.decode((await reader?.read())?.value);
    expect(received).toContain("connected");

    service.createRoom("live", "", []);
    received = decoder.decode((await reader?.read())?.value);
    expect(received).toContain("data: change");
    controller.abort();
  });
});
