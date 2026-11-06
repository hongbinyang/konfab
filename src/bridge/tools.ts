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

  return server;
}
