import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeServer } from "../../src/bridge/tools.js";
import { buildApp } from "../../src/server/api/app.js";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import {
  generateToken,
  KonfabService,
} from "../../src/server/domain/service.js";
import { STOP_INSTRUCTIONS } from "../../src/server/domain/stop.js";

const ROOM = "stop";
const PORT = 18797;
const HOST = `127.0.0.1:${PORT}`;

describe("stop over the page and the connector", () => {
  let db: Db;
  let service: KonfabService;
  let app: FastifyInstance;
  let cookie: string;
  let token: string;
  let client: Client;
  let roomId: number;
  let session: string;

  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return result.isError
      ? { error: result.content[0]!.text }
      : JSON.parse(result.content[0]!.text);
  };
  const page = (method: "POST" | "DELETE", agent = "claude") =>
    app.inject({
      method,
      url: `/api/rooms/${roomId}/agents/${agent}/stop`,
      headers: { host: HOST, cookie, origin: `http://${HOST}` },
    });
  const state = () => service.stops.view(roomId, "claude");
  /** Loses the answer of the first calls to a path, after Konfab made it. */
  const lose = (path: string, times: number) => {
    const real = globalThis.fetch;
    let seen = 0;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await real(...args);
      if (String(args[0]).endsWith(path) && (seen += 1) <= times) {
        await response.text();
        throw new TypeError("Connection lost after the answer");
      }
      return response;
    });
    return () => seen;
  };
  const connect = async (
    bridge: () => ReturnType<typeof createBridgeServer>,
  ) => {
    const [near, far] = InMemoryTransport.createLinkedPair();
    await bridge().connect(far);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(near);
  };

  beforeEach(async () => {
    db = openDatabase(":memory:");
    service = new KonfabService(db, {
      waitTimeoutSeconds: 5,
      turnTimeoutMs: 60_000,
      maxMessageChars: 1000,
    });
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    service.createRoom(ROOM, "", ["claude", "codex"]);
    roomId = service["room"](ROOM).id;
    token = generateToken();
    service.setAgentToken("claude", token);
    app = await buildApp({ service, port: PORT });
    await app.listen({ host: "127.0.0.1", port: PORT });
    const login = await app.inject({
      method: "GET",
      url: `/login?code=${service.createLoginCode()}`,
      headers: { host: HOST },
    });
    cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    await connect(() =>
      createBridgeServer({
        baseUrl: `http://${HOST}`,
        token,
        retryTimeoutMs: 5_000,
      }),
    );
    session = (await tool("join_room", { room: ROOM })).session_id;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await client.close();
    await app.close();
    db.close();
  });

  it("answers a held wait at once, and is confirmed by the connector", async () => {
    const held = tool("wait_for_turn", { session_id: session });
    await vi.waitFor(() =>
      expect(db.prepare("SELECT 1 FROM observed_waits").all()).toHaveLength(1),
    );
    const from = Date.now();
    expect((await page("POST")).json()).toEqual({ ok: true });
    expect(await held).toMatchObject({
      status: "closed",
      reason: "stopped",
      instructions: STOP_INSTRUCTIONS,
    });
    expect(Date.now() - from).toBeLessThan(1000);
    expect(state()).toMatchObject({ state: "received", called_at: null });
    expect((await page("DELETE")).statusCode).toBe(409);
    expect((await page("POST")).statusCode).toBe(409);
  });

  it.each([
    ["post_message", "/agent/post", { body: "Done", next: { kind: "lead" } }],
    ["pass_turn", "/agent/pass", {}],
  ])(
    "is confirmed after %s, and a lost answer is repeated with stop",
    async (name, path, extra) => {
      service.postUserMessage(ROOM, "@claude work");
      const turn = await tool("wait_for_turn", { session_id: session });
      await page("POST");
      expect(state().state).toBe("asked");
      const seen = lose(path, 1);
      const answer = await tool(name, {
        session_id: session,
        turn_id: turn.turn_id,
        ...extra,
      });
      expect(seen()).toBe(2);
      expect(answer).toMatchObject({
        stopped: true,
        instructions: STOP_INSTRUCTIONS,
      });
      expect(state()).toMatchObject({ state: "received", called_at: null });
      expect(
        db.prepare("SELECT 1 FROM messages WHERE sender_id = 'claude'").all(),
      ).toHaveLength(name === "post_message" ? 1 : 0);
    },
  );

  it("repeats a held wait whose answer was lost, and that isn't another call", async () => {
    const seen = lose("/agent/wait", 1);
    const held = tool("wait_for_turn", { session_id: session });
    await vi.waitFor(() =>
      expect(db.prepare("SELECT 1 FROM observed_waits").all()).toHaveLength(1),
    );
    await page("POST");
    expect(await held).toMatchObject({ status: "closed", reason: "stopped" });
    expect(seen()).toBe(2);
    expect(state()).toMatchObject({ state: "received", called_at: null });
  }, 15_000);

  it.each([
    ["post_message", "/agent/stop-received", { body: "Done" }],
    ["wait_for_turn", "/agent/wait-finished", null],
  ])(
    "stays unconfirmed when the confirmation of %s can't be made",
    async (name, path, extra) => {
      const real = globalThis.fetch;
      const refuse = () =>
        vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
          if (String(args[0]).endsWith(path)) throw new TypeError("lost");
          return real(...args);
        });
      if (extra) {
        service.postUserMessage(ROOM, "@claude work");
        const turn = await tool("wait_for_turn", { session_id: session });
        await page("POST");
        refuse();
        await tool(name, {
          session_id: session,
          turn_id: turn.turn_id,
          ...extra,
        });
      } else {
        refuse();
        const held = tool(name, { session_id: session });
        await vi.waitFor(() =>
          expect(db.prepare("SELECT 1 FROM observed_waits").all()).toHaveLength(
            1,
          ),
        );
        await page("POST");
        await held;
      }
      expect(state()).toMatchObject({ state: "answered", called_at: null });
    },
    15_000,
  );

  it("refuses later calls of every kind, says why, and shows that it called", async () => {
    await page("POST");
    await tool("wait_for_turn", { session_id: session });
    expect(state().called_at).toBeNull();
    for (const [name, args] of [
      ["report_status", { kind: "working", detail: "More" }],
      ["acquire_lock", { resource: "/tmp/x", purpose: "y" }],
      ["read_history", {}],
      ["post_message", { turn_id: 1, body: "x" }],
    ] as [string, object][])
      expect(
        (await tool(name, { session_id: session, ...args })).error,
        name,
      ).toBeTruthy();
    expect(
      (
        await tool("report_status", {
          session_id: session,
          kind: "working",
          detail: "x",
        })
      ).error,
    ).toContain("The lead asked you to stop");
    expect(state().called_at).not.toBeNull();
    expect(service.roomState(ROOM).locks).toEqual([]);
  });

  it("works with a connector from before, unconfirmed after a post", async () => {
    const call = (path: string, payload: object) =>
      app.inject({
        method: "POST",
        url: path,
        headers: { host: HOST, authorization: `Bearer ${token}` },
        payload: { session_id: session, ...payload },
      });
    service.postUserMessage(ROOM, "@claude work");
    const turn = (
      await call("/agent/wait", { first: true, timeout_seconds: 1 })
    ).json();
    await page("POST");
    const posted = await call("/agent/post", {
      turn_id: turn.turn_id,
      body: "Done",
    });
    expect(posted.json()).toMatchObject({ stopped: true });
    expect(state().state).toBe("answered");
    const after = await call("/agent/wait", {
      first: true,
      timeout_seconds: 1,
    });
    expect(after.json()).toMatchObject({ status: "closed", reason: "stopped" });
    expect(state().called_at).not.toBeNull();
  });

  it("lets the lead keep it, and is for the signed-in lead only", async () => {
    service.postUserMessage(ROOM, "@claude work");
    await tool("wait_for_turn", { session_id: session });
    await page("POST");
    expect((await page("DELETE")).json()).toEqual({ ok: true });
    expect(state().state).toBeNull();
    const url = `/api/rooms/${roomId}/agents/claude/stop`;
    for (const headers of [
      { host: HOST },
      { host: HOST, authorization: `Bearer ${token}` },
      { host: HOST, cookie, origin: "http://evil.example" },
    ] as Record<string, string>[])
      for (const method of ["POST", "DELETE"] as const) {
        const answer = await app.inject({ method, url, headers });
        expect([401, 403]).toContain(answer.statusCode);
      }
    expect((await page("POST", "nobody")).statusCode).toBe(409);
    expect(state().can).toBe("after_turn");
  });

  it("confirms only its own app's stopped session", async () => {
    const other = generateToken();
    service.setAgentToken("codex", other);
    const codex = service.join("codex", ROOM).session_id;
    service.stops.ask(roomId, "codex");
    const confirm = (bearer: string, id: string) =>
      app.inject({
        method: "POST",
        url: "/agent/stop-received",
        headers: { host: HOST, authorization: `Bearer ${bearer}` },
        payload: { session_id: id },
      });
    expect((await confirm(token, codex)).statusCode).toBeGreaterThanOrEqual(
      400,
    );
    expect((await confirm(other, codex)).statusCode).toBe(200);
    expect(service.stops.view(roomId, "codex").state).toBe("undelivered");
  });
});
