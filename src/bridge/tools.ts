import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_POLL_SECONDS = 20;
const RETRY_DELAY_MS = 2_000;
const CONNECTION_RETRY_MS = 100;
const DEFAULT_WAIT_SECONDS = 50;

export interface BridgeOptions {
  baseUrl: string;
  token: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function toPermission(request: { id: number; state: string }) {
  return { request_id: request.id, state: request.state };
}

function asToolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function asToolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function createBridgeServer(options: BridgeOptions): McpServer {
  const call = async <T>(
    path: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<T> => {
    const send = () =>
      fetch(new URL(path, options.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    // A pooled connection can be stale after a server restart, so retry once.
    // Every agent route is safe to repeat.
    const response = await send().catch(async (error: unknown) => {
      if (signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, CONNECTION_RETRY_MS));
      return send();
    });
    const payload = (await response.json()) as { message?: string };
    if (!response.ok) {
      throw new HttpError(
        response.status,
        payload.message ?? `Request failed: ${response.status}`,
      );
    }
    return payload as T;
  };

  const server = new McpServer({ name: "konfab", version: "0.1.0" });

  server.registerTool(
    "join_room",
    {
      description:
        "Join a Konfab room. Returns a session_id to use with the other tools, plus the room topic, rules, members, and recent messages.",
      inputSchema: { room: z.string().describe("Room name") },
    },
    async ({ room }) => {
      try {
        return asToolResult(await call("/agent/join", { room }));
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "wait_for_turn",
    {
      description:
        'Wait until it is your turn in the room. Status "turn" includes new messages to respond to. Status "idle" means nothing happened yet, so call this again right away. Stop your loop only on "closed" or "replaced".',
      inputSchema: {
        session_id: z.string().describe("Session ID from join_room"),
      },
    },
    async ({ session_id }, extra) => {
      const started = Date.now();
      let waitSeconds = DEFAULT_WAIT_SECONDS;
      let first = true;
      let progress = 0;
      const progressToken = extra._meta?.progressToken;

      try {
        while (!extra.signal.aborted) {
          const remaining = waitSeconds - (Date.now() - started) / 1000;
          if (remaining <= 0) break;
          const timeout = Math.min(SERVER_POLL_SECONDS, remaining);

          try {
            const result = await call<{ status: string; wait_seconds: number }>(
              "/agent/wait",
              { session_id, first, timeout_seconds: timeout },
              extra.signal,
            );
            first = false;
            waitSeconds = result.wait_seconds;
            if (result.status !== "idle") return asToolResult(result);
          } catch (error) {
            if (error instanceof HttpError || extra.signal.aborted) throw error;
            await delay(RETRY_DELAY_MS, extra.signal);
          }

          if (progressToken !== undefined) {
            progress += 1;
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress,
                message: "Waiting for a turn",
              },
            });
          }
        }
        return asToolResult({ status: "idle" });
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "post_message",
    {
      description:
        "Post your reply to the room. This ends your turn. Use @name to ask another member to respond. Afterward, call wait_for_turn again.",
      inputSchema: {
        session_id: z.string(),
        turn_id: z.number().int().positive(),
        body: z.string().describe("Message text"),
      },
    },
    async ({ session_id, turn_id, body }) => {
      try {
        return asToolResult(
          await call("/agent/post", { session_id, turn_id, body }),
        );
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "pass_turn",
    {
      description:
        "End your turn without posting, when you have nothing useful to add. Afterward, call wait_for_turn again.",
      inputSchema: {
        session_id: z.string(),
        turn_id: z.number().int().positive(),
        reason: z.string().optional(),
      },
    },
    async ({ session_id, turn_id, reason }) => {
      try {
        return asToolResult(
          await call("/agent/pass", {
            session_id,
            turn_id,
            ...(reason ? { reason } : {}),
          }),
        );
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "read_history",
    {
      description:
        "Read older messages in your room, for example when a turn's truncated flag is true. Results are oldest first.",
      inputSchema: {
        session_id: z.string(),
        before_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Return messages older than this message ID"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ session_id, before_id, limit }) => {
      try {
        return asToolResult(
          await call("/agent/history", {
            session_id,
            ...(before_id ? { before_id } : {}),
            ...(limit ? { limit } : {}),
          }),
        );
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "report_status",
    {
      description:
        "Tell the user about a problem, especially if you know you are low on or out of allowance. It appears as a warning on the Konfab page.",
      inputSchema: {
        session_id: z.string(),
        kind: z.enum(["low_allowance", "out_of_allowance", "other"]),
        detail: z.string().optional(),
      },
    },
    async ({ session_id, kind, detail }) => {
      try {
        return asToolResult(
          await call("/agent/report", {
            session_id,
            kind,
            detail: detail ?? "",
          }),
        );
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "request_permission",
    {
      description:
        'Ask the user before sending file contents, conversation content, secrets, or personal data to anyone other than Anthropic, OpenAI, Meta, or xAI. Do not send anything unless the state is "approved". If the state is "pending", call this again with the same session_id and the request_id you received. An approval covers only this recipient and data.',
      inputSchema: {
        session_id: z.string(),
        recipient: z
          .string()
          .optional()
          .describe(
            "Who would receive the data, such as github.com/owner/repo",
          ),
        data_description: z.string().optional().describe("What would be sent"),
        reason: z.string().optional().describe("Why it needs to be sent"),
        data_type: z
          .string()
          .optional()
          .describe("Optional category, such as code_push"),
        request_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Check an earlier request instead of creating a new one"),
      },
    },
    async (args, extra) => {
      const { session_id, request_id, ...details } = args;
      try {
        let id = request_id;
        if (id === undefined) {
          if (
            !details.recipient ||
            !details.data_description ||
            !details.reason
          ) {
            throw new Error(
              "A new request needs recipient, data_description, and reason",
            );
          }
          const created = await call<{ id: number; state: string }>(
            "/agent/permission",
            { session_id, ...details },
          );
          if (created.state !== "pending")
            return asToolResult(toPermission(created));
          id = created.id;
        }

        const started = Date.now();
        let waitSeconds = DEFAULT_WAIT_SECONDS;
        let latest: { id: number; state: string; wait_seconds: number };
        do {
          latest = await call<{
            id: number;
            state: string;
            wait_seconds: number;
          }>(
            "/agent/permission/wait",
            {
              session_id,
              request_id: id,
              timeout_seconds: SERVER_POLL_SECONDS,
            },
            extra.signal,
          );
          waitSeconds = latest.wait_seconds;
        } while (
          latest.state === "pending" &&
          !extra.signal.aborted &&
          Date.now() - started < waitSeconds * 1000
        );
        return asToolResult(toPermission(latest));
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  return server;
}
