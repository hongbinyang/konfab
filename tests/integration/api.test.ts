import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/api/app.js";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";

const PORT = 18788;
const HOST = `127.0.0.1:${PORT}`;

describe("page API", () => {
  let db: Db;
  let service: KonfabService;
  let app: FastifyInstance;
  let cookie: string;

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
    service = new KonfabService(db, {
      maxConsecutiveAgentMessages: 5,
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60_000,
      maxMessageChars: 1000,
    });
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    app = await buildApp({ service, port: PORT });

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
        for (const url of ["/api/overview", "/api/events", "/api/rooms/1"]) {
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

  it("searches and exports a room", async () => {
    const { id } = service.createRoom("notes", "A topic", ["claude"]);
    service.postUserMessage(id, "Find this 100%");
    service.postUserMessage(id, "Other text");

    const search = await call("GET", `/api/rooms/${id}/search?q=100%25`);
    expect(search.json().messages).toHaveLength(1);
    const empty = await call("GET", `/api/rooms/${id}/search?q=%20`);
    expect(empty.statusCode).toBe(400);

    const exported = await call("GET", `/api/rooms/${id}/export`);
    expect(exported.headers["content-disposition"]).toContain("notes.md");
    expect(exported.body).toContain("# notes");
    expect(exported.body).toContain("Find this 100%");
  });

  it("extends an agent's hours and rejects unknown agents", async () => {
    const ok = await call("POST", "/api/agents/claude/extend-hours", {
      minutes: 60,
    });
    expect(ok.statusCode).toBe(200);
    const missing = await call("POST", "/api/agents/ghost/extend-hours", {
      minutes: 60,
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await call("POST", "/api/agents/claude/extend-hours", {
      minutes: 5000,
    });
    expect(invalid.statusCode).toBe(400);
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
