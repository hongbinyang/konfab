import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      maxConsecutiveAgentMessages: 5,
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
    await client.close();
    await app.close();
    db.close();
  });

  it("lists the Phase 0 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "join_room",
      "pass_turn",
      "post_message",
      "read_history",
      "report_status",
      "request_permission",
      "wait_for_turn",
    ]);
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
