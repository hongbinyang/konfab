import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const ROOM = "test";
const PORT = 18787;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

describe("server and bridge", () => {
  let db: Db;
  let service: KonfabService;
  let app: FastifyInstance;
  let token: string;
  let client: Client;

  const callTool = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as ToolResult;
    return {
      isError: result.isError,
      value: JSON.parse(result.content[0]?.text ?? "null"),
    };
  };

  beforeEach(async () => {
    db = openDatabase(":memory:");
    service = new KonfabService(db, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60_000,
      maxMessageChars: 1000,
    });
    service.ensureAgent("claude", "Claude");
    service.createRoom(ROOM, "Topic", ["claude"]);
    token = generateToken();
    service.setAgentToken("claude", token);

    app = await buildApp({ service, port: PORT });
    await app.listen({ host: "127.0.0.1", port: PORT });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createBridgeServer({
      baseUrl: `http://127.0.0.1:${PORT}`,
      token,
    }).connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await client.close();
    await app.close();
    db.close();
  });

  it("recovers a post after a transient startup outage", async () => {
    const { value: joined } = await callTool("join_room", { room: ROOM });
    service.postUserMessage(ROOM, "Please respond");
    const { value: turn } = await callTool("wait_for_turn", {
      session_id: joined.session_id,
    });
    const originalFetch = globalThis.fetch;
    let failures = 0;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith("/agent/post") && failures++ < 2)
        return new Response(JSON.stringify({ message: "Starting" }), {
          status: 503,
        });
      return originalFetch(...args);
    });
    const result = (await client.callTool({
      name: "post_message",
      arguments: {
        session_id: joined.session_id,
        turn_id: turn.turn_id,
        body: "Recovered",
      },
    })) as ToolResult;
    expect(result.isError).not.toBe(true);
  });

  it("does not duplicate a post when its successful response is lost", async () => {
    const { value: joined } = await callTool("join_room", { room: ROOM });
    service.postUserMessage(ROOM, "Please respond");
    const { value: turn } = await callTool("wait_for_turn", {
      session_id: joined.session_id,
    });
    const originalFetch = globalThis.fetch;
    let lost = false;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      if (String(args[0]).endsWith("/agent/post") && !lost) {
        lost = true;
        await response.text();
        throw new TypeError("Connection lost after commit");
      }
      return response;
    });
    const result = await callTool("post_message", {
      session_id: joined.session_id,
      turn_id: turn.turn_id,
      body: "Exactly once",
    });
    expect(result.isError).not.toBe(true);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE body = ?")
        .get("Exactly once"),
    ).toEqual({ count: 1 });
  });

  it("replays joins and permissions without repeating mutations", async () => {
    const headers = {
      host: `127.0.0.1:${PORT}`,
      authorization: `Bearer ${token}`,
      "x-konfab-request-id": "12345678-1234-4234-8234-123456789abc",
    };
    const first = await app.inject({
      method: "POST",
      url: "/agent/join",
      headers,
      payload: { room: ROOM },
    });
    const second = await app.inject({
      method: "POST",
      url: "/agent/join",
      headers,
      payload: { room: ROOM },
    });
    expect(second.json()).toEqual(first.json());
    const permissionHeaders = {
      ...headers,
      "x-konfab-request-id": "12345678-1234-4234-8234-123456789abd",
    };
    const payload = {
      session_id: first.json().session_id,
      recipient: "example.com",
      data_description: "test",
      reason: "test",
    };
    const permission = await app.inject({
      method: "POST",
      url: "/agent/permission",
      headers: permissionHeaders,
      payload,
    });
    const replay = await app.inject({
      method: "POST",
      url: "/agent/permission",
      headers: permissionHeaders,
      payload,
    });
    expect(replay.json()).toEqual(permission.json());
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM permission_requests").get(),
    ).toEqual({ count: 1 });
    const conflict = await app.inject({
      method: "POST",
      url: "/agent/permission",
      headers: permissionHeaders,
      payload: { ...payload, reason: "changed" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("marks old bridges for connector reload and clears the marker on refresh", async () => {
    await app.inject({
      method: "POST",
      url: "/agent/join",
      headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}` },
      payload: { room: ROOM },
    });
    expect(service.roomState(ROOM).agents[0]?.bridge_outdated).toBe(true);
    await callTool("join_room", { room: ROOM });
    expect(service.roomState(ROOM).agents[0]?.bridge_outdated).toBe(false);
  });

  it("refuses receipt-dependent mutations against an old server", async () => {
    const originalFetch = globalThis.fetch;
    let mutations = 0;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith("/agent/protocol"))
        return new Response("{}", { status: 404 });
      mutations++;
      return originalFetch(...args);
    });
    const result = (await client.callTool({
      name: "join_room",
      arguments: { room: ROOM },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(mutations).toBe(0);
  });

  it("replays a permission after reopening the database and server", async () => {
    const directory = mkdtempSync(join(tmpdir(), "konfab-replay-"));
    const filename = join(directory, "state.db");
    let diskDb = openDatabase(filename);
    let diskService = new KonfabService(diskDb, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60000,
      maxMessageChars: 1000,
    });
    diskService.ensureAgent("claude", "Claude");
    diskService.createRoom(ROOM, "Topic", ["claude"]);
    diskService.setAgentToken("claude", token);
    const joined = diskService.join("claude", ROOM);
    diskService.reportStatus(
      "claude",
      joined.session_id,
      "working",
      "Restart test",
    );
    diskService.postUserMessage(ROOM, "Please respond after restart");
    const activeTurn = diskService.poll("claude", joined.session_id, true);
    if (activeTurn.status !== "turn") throw new Error("Expected active turn");
    diskService.setRoomPaused(ROOM, true);
    const frozenBudget =
      diskService.roomState(ROOM).agents[0]!.run_clock!.remaining_ms;
    let diskApp = await buildApp({ service: diskService, port: PORT });
    const headers = {
      host: `127.0.0.1:${PORT}`,
      authorization: `Bearer ${token}`,
      "x-konfab-request-id": "12345678-1234-4234-8234-123456789abe",
    };
    const payload = {
      session_id: joined.session_id,
      recipient: "example.com",
      data_description: "test",
      reason: "test",
    };
    try {
      const first = await diskApp.inject({
        method: "POST",
        url: "/agent/permission",
        headers,
        payload,
      });
      expect(first.statusCode).toBe(200);
      await diskApp.close();
      diskDb.close();
      diskDb = openDatabase(filename);
      diskService = new KonfabService(diskDb, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      diskService.recoverAfterRestart();
      expect(diskService.roomState(ROOM).agents[0]!.run_clock).toMatchObject({
        remaining_ms: frozenBudget,
        paused: true,
      });
      expect(diskService.roomState(ROOM).agents[0]?.working?.detail).toBe(
        "Restart test",
      );
      diskApp = await buildApp({ service: diskService, port: PORT });
      const postPayload = {
        session_id: joined.session_id,
        turn_id: activeTurn.turn_id,
        body: "Resumed original work",
      };
      const postHeaders = {
        host: `127.0.0.1:${PORT}`,
        authorization: `Bearer ${token}`,
      };
      const post = await diskApp.inject({
        method: "POST",
        url: "/agent/post",
        headers: postHeaders,
        payload: postPayload,
      });
      expect(post.statusCode).toBe(200);
      const duplicate = await diskApp.inject({
        method: "POST",
        url: "/agent/post",
        headers: postHeaders,
        payload: postPayload,
      });
      expect(duplicate.json()).toEqual(post.json());
      expect(
        diskDb
          .prepare("SELECT COUNT(*) AS count FROM messages WHERE body = ?")
          .get(postPayload.body),
      ).toEqual({ count: 1 });
      const replay = await diskApp.inject({
        method: "POST",
        url: "/agent/permission",
        headers,
        payload,
      });
      expect(replay.json()).toEqual(first.json());
      expect(
        diskDb
          .prepare("SELECT COUNT(*) AS count FROM permission_requests")
          .get(),
      ).toEqual({ count: 1 });
      const readId = post.json().message_id as number;
      diskService.setRoomPaused(ROOM, false);
      diskService.ensureAgent("codex", "Codex");
      diskService.setMembers(ROOM, ["claude", "codex"]);
      diskService.join("codex", ROOM);
      const savedRepair = diskService.handOff(
        "claude",
        joined.session_id,
        readId,
        "codex",
      );
      diskService.markLeadRead(ROOM, [readId]);
      const savedCursor = diskService.roomState(ROOM).read_info.cursor;
      diskDb.prepare("UPDATE bridge_receipts SET created_at = 0").run();
      await diskApp.close();
      diskDb.close();
      diskDb = openDatabase(filename);
      const restartedReadService = new KonfabService(diskDb, {
        waitTimeoutSeconds: 1,
        turnTimeoutMs: 60000,
        maxMessageChars: 1000,
      });
      expect(
        restartedReadService.handOff(
          "claude",
          joined.session_id,
          readId,
          "codex",
        ),
      ).toEqual(savedRepair);
      expect(restartedReadService.roomState(ROOM).routing.queued).toHaveLength(
        1,
      );
      expect(restartedReadService.roomState(ROOM).read_info).toMatchObject({
        cursor: savedCursor,
        unread_count: 0,
      });
      expect(
        diskDb.prepare("SELECT COUNT(*) AS count FROM bridge_receipts").get(),
      ).toEqual({ count: 0 });
    } finally {
      await diskApp.close();
      diskDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("classifies every agent POST route for retry safety", () => {
    const apiSource = readFileSync(
      new URL("../../src/server/api/app.ts", import.meta.url),
      "utf8",
    );
    const bridgeSource = readFileSync(
      new URL("../../src/bridge/tools.ts", import.meta.url),
      "utf8",
    );
    const allowlist = bridgeSource.slice(
      bridgeSource.indexOf("const repeatSafe = new Set(["),
      bridgeSource.indexOf("]).has(path)"),
    );
    const routes = [
      ...apiSource.matchAll(/app\.post\("(\/agent\/[^"]+)"/g),
    ].map((match) => match[1]);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expect(allowlist).toContain(`"${route}"`);
  });

  it("explains an exhausted outage budget without promising turn survival", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createBridgeServer({
      baseUrl: "http://127.0.0.1:1",
      token,
      retryTimeoutMs: 0,
    }).connect(serverTransport);
    const other = new Client({ name: "test", version: "1.0.0" });
    await other.connect(clientTransport);
    try {
      const result = (await other.callTool({
        name: "join_room",
        arguments: { room: ROOM },
      })) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("request was not confirmed");
      expect(result.content[0]?.text).toContain("continue the loop");
    } finally {
      await other.close();
    }
  });

  it("repairs an unmentioned handoff through the bridge", async () => {
    service.ensureAgent("codex", "Codex");
    service.setMembers(ROOM, ["claude", "codex"]);
    const target = service.join("codex", ROOM).session_id;
    const { value: joined } = await callTool("join_room", { room: ROOM });
    service.postUserMessage(ROOM, "@claude start");
    const { value: turn } = await callTool("wait_for_turn", {
      session_id: joined.session_id,
    });
    const { value: posted } = await callTool("post_message", {
      session_id: joined.session_id,
      turn_id: turn.turn_id,
      body: "@lead design approved",
    });
    expect(posted.routing_warning).toContain("hand_off");
    const { value: repair } = await callTool("hand_off", {
      session_id: joined.session_id,
      source_message_id: posted.message_id,
      to: "codex",
    });
    expect(service.poll("codex", target, true)).toMatchObject({
      status: "turn",
      turn_id: repair.turn_id,
      handoff_repair: { source_message_id: posted.message_id },
    });
  });

  it("lists the Phase 0 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "hand_off",
      "join_room",
      "pass_turn",
      "post_message",
      "propose_decision",
      "read_decisions",
      "read_history",
      "report_status",
      "request_permission",
      "wait_for_turn",
    ]);
  });

  it("lets agents propose and read confirmed decisions", async () => {
    const { value: joined } = await callTool("join_room", { room: ROOM });
    const { value: proposal } = await callTool("propose_decision", {
      session_id: joined.session_id,
      body: "Ship Wednesday",
    });
    expect(proposal.status).toBe("proposed");
    expect(
      (await callTool("read_decisions", { session_id: joined.session_id }))
        .value.decisions,
    ).toHaveLength(0);
    service.updateDecision(ROOM, proposal.id, "confirm");
    expect(
      (await callTool("read_decisions", { session_id: joined.session_id }))
        .value.decisions[0].body,
    ).toBe("Ship Wednesday");
  });

  it("returns idle when the wait ends with nothing to do", async () => {
    const { value: joined } = await callTool("join_room", { room: ROOM });
    const { value } = await callTool("wait_for_turn", {
      session_id: joined.session_id,
    });
    expect(value.status).toBe("idle");
    expect(service.roomState(ROOM).agents[0]?.stats.model_wait_calls).toBe(1);
    expect(
      service.roomState(ROOM).agents[0]?.stats.longest_wait_ms,
    ).toBeGreaterThan(0);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM observed_waits WHERE ended_at IS NOT NULL",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("wakes a waiting agent when the user posts, then records its reply", async () => {
    const { value: joined } = await callTool("join_room", { room: ROOM });
    const waiting = callTool("wait_for_turn", {
      session_id: joined.session_id,
    });
    setTimeout(() => service.postUserMessage(ROOM, "Hello"), 50);

    const { value: turn } = await waiting;
    expect(turn.status).toBe("turn");
    expect(turn.messages[0].body).toBe("Hello");

    await callTool("post_message", {
      session_id: joined.session_id,
      turn_id: turn.turn_id,
      body: "Hi there",
    });
    expect(
      service.roomState(ROOM).messages.map((message) => message.body),
    ).toEqual(["Hello", "Hi there"]);
  });

  it("reports an invalid token as a tool error", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createBridgeServer({
      baseUrl: `http://127.0.0.1:${PORT}`,
      token: "wrong",
    }).connect(serverTransport);
    const other = new Client({ name: "test", version: "1.0.0" });
    await other.connect(clientTransport);
    const result = (await other.callTool({
      name: "join_room",
      arguments: { room: ROOM },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid agent token");
    await other.close();
  });

  it("sends progress while waiting", async () => {
    const { value: joined } = await callTool("join_room", { room: ROOM });
    let updates = 0;
    await client.callTool(
      {
        name: "wait_for_turn",
        arguments: { session_id: joined.session_id },
      },
      undefined,
      { onprogress: () => (updates += 1) },
    );
    expect(updates).toBeGreaterThan(0);
  });

  it("ends a wait as idle when the server cannot be reached", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createBridgeServer({
      baseUrl: "http://127.0.0.1:1",
      token,
      defaultWaitSeconds: 1,
    }).connect(serverTransport);
    const other = new Client({ name: "test", version: "1.0.0" });
    await other.connect(clientTransport);
    const started = Date.now();
    const result = (await other.callTool({
      name: "wait_for_turn",
      arguments: { session_id: "any" },
    })) as ToolResult;
    expect(JSON.parse(result.content[0]?.text ?? "null").status).toBe("idle");
    expect(Date.now() - started).toBeLessThan(5000);
    await other.close();
  });

  it("waits for a permission answer and reports the result", async () => {
    const { value: joined } = await callTool("join_room", { room: ROOM });
    const { value: pending } = await callTool("request_permission", {
      session_id: joined.session_id,
      recipient: "example.com",
      data_description: "A log file",
      reason: "To debug a problem",
    });
    // With no answer, the call returns pending when the wait ends.
    expect(pending.state).toBe("pending");
    expect(service.listPermissions("pending")).toHaveLength(1);

    const waiting = callTool("request_permission", {
      session_id: joined.session_id,
      request_id: pending.request_id,
    });
    setTimeout(
      () => service.decidePermission(pending.request_id, "denied"),
      50,
    );
    expect((await waiting).value.state).toBe("denied");
  });

  it("returns the approved push scope through the bridge", async () => {
    const { value: joined } = await callTool("join_room", { room: ROOM });
    const scope = {
      repository: "github.com/me/repo",
      branch: "feature",
      base: "a".repeat(40),
      head: "b".repeat(40),
    };
    const waiting = callTool("request_permission", {
      session_id: joined.session_id,
      recipient: scope.repository,
      data_description: "commits",
      reason: "push",
      data_type: "code_push",
      push_scope: scope,
    });
    setTimeout(() => {
      const pending = service.listPermissions("pending")[0];
      if (pending) service.decidePermission(pending.id, "approved");
    }, 100);
    const { value } = await waiting;
    expect(value).toMatchObject({ state: "approved", push_scope: scope });
    expect(value.instruction).toContain("if anything changed, request again");
  });

  it("does not present a legacy unscoped push approval as approved", async () => {
    const { value: joined } = await callTool("join_room", { room: ROOM });
    const legacy = service.requestPermission("claude", joined.session_id, {
      recipient: "github.com/me/repo",
      data_description: "old commits",
      reason: "push",
    });
    db.prepare(
      "UPDATE permission_requests SET data_type = 'code_push', state = 'approved' WHERE id = ?",
    ).run(legacy.id);
    const { value } = await callTool("request_permission", {
      session_id: joined.session_id,
      request_id: legacy.id,
    });
    expect(value.state).toBe("scope_required");
    expect(value.instruction).toContain("Request a new approval");
  });

  it("rejects an incomplete new permission request", async () => {
    const { value: joined } = await callTool("join_room", { room: ROOM });
    const result = (await client.callTool({
      name: "request_permission",
      arguments: { session_id: joined.session_id, recipient: "example.com" },
    })) as ToolResult;
    expect(result.isError).toBe(true);
  });

  it("reads history and records a status report", async () => {
    const { value: joined } = await callTool("join_room", { room: ROOM });
    service.postUserMessage(ROOM, "First");
    const { value: history } = await callTool("read_history", {
      session_id: joined.session_id,
    });
    expect(history.messages.map((m: { body: string }) => m.body)).toEqual([
      "First",
    ]);

    await callTool("report_status", {
      session_id: joined.session_id,
      kind: "low_allowance",
      detail: "Almost out",
    });
    expect(service.listReports()[0]?.detail).toBe("Almost out");
  });
});
