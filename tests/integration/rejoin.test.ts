import { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeServer } from "../../src/bridge/tools.js";
import { buildApp } from "../../src/server/api/app.js";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import type { SendResult } from "../../src/server/domain/rejoin.js";
import {
  generateToken,
  KonfabService,
} from "../../src/server/domain/service.js";

const ROOM = "rejoin";
const PORT = 18796;
const HOST = `127.0.0.1:${PORT}`;
const HERE = "019a0000-0000-7000-8000-000000000001";
const OTHER = "019a0000-0000-7000-8000-000000000002";
const CLOSED = {
  status: "closed",
  next: "This request is closed. End your turn and do nothing else.",
};

describe("rejoin over the page and the connector", () => {
  let db: Db;
  let now: number;
  let service: KonfabService;
  let app: FastifyInstance;
  let cookie: string;
  let token: string;
  let logs: string[];
  let sent: { conversation: string; number: string }[];
  let send: () => Promise<SendResult>;
  let clients: Client[];
  let roomId: number;

  const page = (method: "POST" | "DELETE", payload?: object) =>
    app.inject({
      method,
      url: `/api/rooms/${roomId}/agents/codex/rejoin`,
      headers: { host: HOST, cookie, origin: `http://${HOST}` },
      ...(payload ? { payload } : {}),
    });
  const connect = async (name = "codex-mcp-client", conversation?: string) => {
    const [near, far] = InMemoryTransport.createLinkedPair();
    await createBridgeServer({
      baseUrl: `http://${HOST}`,
      token,
      retryTimeoutMs: 5_000,
      ...(conversation === undefined ? {} : { conversation }),
    }).connect(far);
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(near);
    clients.push(client);
    return async (
      tool: string,
      args: object,
      meta?: Record<string, unknown>,
    ) => {
      const result = (await client.callTool({
        name: tool,
        arguments: args as Record<string, unknown>,
        ...(meta ? { _meta: meta } : {}),
      })) as { isError?: boolean; content: { text: string }[] };
      return result.isError
        ? { error: result.content[0]!.text }
        : JSON.parse(result.content[0]!.text);
    };
  };
  const conversation = () =>
    (
      db
        .prepare(
          "SELECT conversation_id AS id FROM sessions ORDER BY rowid DESC LIMIT 1",
        )
        .get() as { id: string | null }
    ).id;
  const away = () => {
    now += 90_001;
    service.tick();
  };

  beforeEach(async () => {
    now = Date.now();
    logs = [];
    sent = [];
    clients = [];
    send = async () => "taken";
    db = openDatabase(":memory:");
    service = new KonfabService(db, {
      now: () => now,
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60_000,
      maxMessageChars: 1000,
    });
    service.rejoin.available = () => true;
    service.ensureAgent("claude", "Claude");
    service.ensureAgent("codex", "Codex");
    service.createRoom(ROOM, "", ["claude", "codex"]);
    roomId = service["room"](ROOM).id;
    token = generateToken();
    service.setAgentToken("codex", token);
    app = await buildApp({
      service,
      port: PORT,
      sendRejoin: (to, number) => {
        sent.push({ conversation: to, number });
        return send();
      },
      logger: true,
      logStream: new Writable({
        write(chunk, _encoding, done) {
          logs.push(String(chunk));
          done();
        },
      }),
    });
    await app.listen({ host: "127.0.0.1", port: PORT });
    const login = await app.inject({
      method: "GET",
      url: `/login?code=${service.createLoginCode()}`,
      headers: { host: HOST },
    });
    cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const client of clients) await client.close();
    await app.close();
    db.close();
  });

  it("takes the conversation only from this client's call metadata, and only as a full number", async () => {
    const call = await connect();
    const cases: [Record<string, unknown> | undefined, string | null][] = [
      [{ threadId: HERE }, HERE],
      [undefined, null],
      [{}, null],
      [{ threadId: HERE.toUpperCase() }, null],
      [{ threadId: `${HERE}\r\nX-Other: 1` }, null],
      [{ threadId: 5 }, null],
      [{ threadId: [HERE] }, null],
      [{ sessionId: HERE, thread_id: HERE }, null],
    ];
    for (const [meta, expected] of cases) {
      await call("join_room", { room: ROOM }, meta);
      expect(conversation(), JSON.stringify(meta)).toBe(expected);
    }
    const another = await connect("another-client");
    await another("join_room", { room: ROOM }, { threadId: HERE });
    expect(conversation()).toBeNull();
  });

  it("sends the environment's conversation only for the app that has it there, on its own route", async () => {
    const seen: Record<string, string>[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith("/agent/join"))
        seen.push(args[1]!.headers as Record<string, string>);
      return real(...args);
    });
    const cases: [string, string | undefined, object | undefined, string[]][] =
      [
        ["claude-code", HERE, undefined, ["X-Konfab-Watched-Conversation"]],
        ["claude-code", HERE.toUpperCase(), undefined, []],
        ["claude-code", "x\r\nX-Other: 1", undefined, []],
        ["claude-code", undefined, { threadId: HERE }, []],
        ["another", HERE, { threadId: HERE }, []],
        [
          "codex-mcp-client",
          OTHER,
          { threadId: HERE },
          ["X-Konfab-Conversation"],
        ],
      ];
    for (const [name, environment, meta, expected] of cases) {
      const call = await connect(name, environment);
      const reply = await call(
        "join_room",
        { room: ROOM },
        meta as Record<string, unknown> | undefined,
      );
      // Off here: nothing to start, nothing kept.
      expect(reply).not.toHaveProperty("watcher");
      const headers = seen.at(-1)!;
      expect(
        Object.keys(headers).filter((key) => /conversation/i.test(key)),
        name,
      ).toEqual(expected);
      for (const key of expected) expect(headers[key]).toBe(HERE);
      if (name === "claude-code") expect(conversation()).toBeNull();
    }
  });

  it("answers a join byte for byte as before while the watcher is off", async () => {
    const join = async (headers: Record<string, string>) => {
      const answer = await app.inject({
        method: "POST",
        url: "/agent/join",
        headers: { host: HOST, authorization: `Bearer ${token}`, ...headers },
        payload: { room: ROOM },
      });
      return answer.body.replace(/"session_id":"[^"]+"/, "");
    };
    expect(await join({ "x-konfab-watched-conversation": HERE })).toBe(
      await join({}),
    );
    const watch = await app.inject({
      method: "POST",
      url: "/agent/watch",
      headers: { host: HOST, authorization: "Bearer kfw_x" },
      payload: { pid: 1 },
    });
    expect(watch.statusCode).toBe(401);
  });

  it("brings the agent back once, and says nothing secret anywhere", async () => {
    const call = await connect();
    const first = await call("join_room", { room: ROOM }, { threadId: HERE });
    await call("wait_for_turn", { session_id: first.session_id });
    away();
    const answer = await page("POST", {});
    expect(answer.json()).toEqual({ ok: true });
    expect(sent).toEqual([{ conversation: HERE, number: sent[0]!.number }]);
    const { number } = sent[0]!;
    const joined = await call(
      "rejoin_room",
      { request: number },
      { threadId: HERE },
    );
    expect(joined).toMatchObject({ room: ROOM });
    expect(service.rejoin.view(roomId, "codex").request?.state).toBe("joined");
    expect(
      await call("rejoin_room", { request: number }, { threadId: OTHER }),
    ).toEqual(CLOSED);
    expect(
      await call("rejoin_room", { request: "x" }, { threadId: HERE }),
    ).toEqual(CLOSED);
    expect(await call("rejoin_room", { request: number })).toEqual(CLOSED);
    const another = await connect("another-client");
    expect(
      await another("rejoin_room", { request: number }, { threadId: HERE }),
    ).toEqual(CLOSED);
    await call("wait_for_turn", { session_id: joined.session_id });
    expect(service.rejoin.view(roomId, "codex").request).toBeNull();
    const get = async (url: string) =>
      (await app.inject({ url, headers: { host: HOST, cookie } })).body;
    const shown = [
      answer.body,
      JSON.stringify([first, joined]),
      logs.join(""),
      await get(`/api/rooms/${roomId}`),
      await get("/api/overview"),
      await get(`/api/rooms/${roomId}/activity`),
      await get(`/api/rooms/${roomId}/export`),
      service.exportRoom(ROOM).markdown,
    ];
    expect(shown[2]).toContain("/agent/rejoin");
    expect(shown[3]).toContain('"rejoin"');
    expect(shown[5]).toContain("rejoined");
    for (const text of shown) {
      expect(text).not.toContain(number);
      expect(text).not.toContain(HERE);
    }
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]) {
      const text = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
      expect(text, name).not.toContain(number);
      if (text.includes(HERE))
        expect(["sessions", "rejoin_requests"]).toContain(name);
    }
  });

  it("answers the same session when the connector repeats a call whose answer was lost", async () => {
    const call = await connect();
    await call("join_room", { room: ROOM }, { threadId: HERE });
    away();
    await page("POST", {});
    const real = globalThis.fetch;
    let calls = 0;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await real(...args);
      if (String(args[0]).endsWith("/agent/rejoin")) {
        calls += 1;
        if (calls === 1) {
          await response.text();
          throw new TypeError("Connection lost after commit");
        }
      }
      return response;
    });
    const joined = await call(
      "rejoin_room",
      { request: sent[0]!.number },
      { threadId: HERE },
    );
    expect(calls).toBe(2);
    expect(joined.session_id).toBe(
      (
        db
          .prepare("SELECT joined_session_id AS id FROM rejoin_requests")
          .get() as { id: string }
      ).id,
    );
    expect(db.prepare("SELECT 1 FROM sessions").all()).toHaveLength(2);
  });

  it("takes a call that arrives while the command is still running", async () => {
    const call = await connect();
    await call("join_room", { room: ROOM }, { threadId: HERE });
    away();
    send = async () => {
      await call(
        "rejoin_room",
        { request: sent[0]!.number },
        { threadId: HERE },
      );
      return "unsure";
    };
    expect((await page("POST", {})).statusCode).toBe(200);
    expect(service.rejoin.view(roomId, "codex").request?.state).toBe("joined");
  });

  it("sends once for two clicks, again only after a yes, and cancels", async () => {
    const call = await connect();
    await call("join_room", { room: ROOM }, { threadId: HERE });
    away();
    const clicks = await Promise.all([page("POST", {}), page("POST", {})]);
    expect(clicks.map((answer) => answer.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(sent).toHaveLength(1);
    expect((await page("DELETE")).statusCode).toBe(200);
    expect((await page("DELETE")).statusCode).toBe(409);
    const refused = await page("POST", {});
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain("rejoin_earlier");
    expect(sent).toHaveLength(1);
    expect((await page("POST", { again: true })).statusCode).toBe(200);
    expect(sent).toHaveLength(2);
    expect(
      await call(
        "rejoin_room",
        { request: sent[0]!.number },
        { threadId: HERE },
      ),
    ).toEqual(CLOSED);
  });

  it("stays unsure when sending fails in an unknown way", async () => {
    const call = await connect();
    await call("join_room", { room: ROOM }, { threadId: HERE });
    away();
    send = async () => {
      throw new Error("?");
    };
    expect((await page("POST", {})).statusCode).toBe(500);
    expect(service.rejoin.view(roomId, "codex").request).toMatchObject({
      state: "waiting",
      unsure: true,
    });
    expect(sent).toHaveLength(1);
  });

  it("is for the signed-in lead on this page only", async () => {
    const call = await connect();
    await call("join_room", { room: ROOM }, { threadId: HERE });
    away();
    const url = `/api/rooms/${roomId}/agents/codex/rejoin`;
    for (const headers of [
      { host: HOST },
      { host: HOST, authorization: `Bearer ${token}` },
      { host: HOST, cookie, origin: "http://evil.example" },
    ] as Record<string, string>[])
      for (const method of ["POST", "DELETE"] as const) {
        const answer = await app.inject({ method, url, headers });
        expect(answer.statusCode).toBeGreaterThanOrEqual(401);
        expect(answer.statusCode).toBeLessThan(404);
      }
    const odd = await page("POST", { again: true, message: "hello" });
    expect(odd.statusCode).toBe(400);
    expect(sent).toEqual([]);
  });

  it("refuses when no command can be used", async () => {
    service.rejoin.available = () => false;
    const call = await connect();
    await call("join_room", { room: ROOM }, { threadId: HERE });
    away();
    expect((await page("POST", {})).statusCode).toBe(409);
    expect(sent).toEqual([]);
  });
});
