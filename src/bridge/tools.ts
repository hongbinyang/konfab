import { BRIDGE_PROTOCOL_VERSION } from "../protocol.js";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_POLL_SECONDS = 20;
const RETRY_DELAY_MS = 2_000;
const CONNECTION_RETRY_MS = 100;
const DEFAULT_WAIT_SECONDS = 50;

export interface BridgeOptions {
  baseUrl: string;
  token: string;
  /** How long to wait if the server cannot be reached to provide its setting. */
  defaultWaitSeconds?: number;
  /** Recovery budget for repeat-safe requests during a server outage. */
  retryTimeoutMs?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function toPermission(request: {
  id: number;
  state: string;
  recipient?: string;
  data_description?: string;
  data_type?: string | null;
  push_repository?: string | null;
  push_branch?: string | null;
  push_base?: string | null;
  push_head?: string | null;
}) {
  const scope =
    request.push_repository &&
    request.push_branch &&
    request.push_base &&
    request.push_head
      ? {
          repository: request.push_repository,
          branch: request.push_branch,
          base: request.push_base,
          head: request.push_head,
        }
      : null;
  return {
    request_id: request.id,
    state:
      request.data_type?.toLowerCase() === "code_push" &&
      request.state === "approved" &&
      !scope
        ? "scope_required"
        : request.state,
    recipient: request.recipient,
    data_description: request.data_description,
    ...(scope
      ? {
          push_scope: scope,
          instruction:
            "Before pushing, check that the repo, branch, and base..head match this approval exactly; if anything changed, request again.",
        }
      : request.data_type?.toLowerCase() === "code_push" &&
          request.state === "approved"
        ? {
            instruction:
              "This legacy approval has no recorded push scope. Request a new approval before pushing.",
          }
        : {}),
  };
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
    const requestKey = randomUUID();
    const receiptProtected = [
      "/agent/join",
      "/agent/permission",
      "/agent/report",
    ].includes(path);
    let protocolChecked = !receiptProtected;
    const send = async () => {
      if (!protocolChecked) {
        const capability = await fetch(
          new URL("/agent/protocol", options.baseUrl),
          {
            headers: {
              Authorization: `Bearer ${options.token}`,
              "X-Konfab-Protocol": String(BRIDGE_PROTOCOL_VERSION),
            },
            signal:
              signal ?? AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          },
        );
        if ([502, 503, 504].includes(capability.status))
          throw new TypeError("Server starting");
        if (!capability.ok) {
          const error = (await capability.json().catch(() => ({}))) as {
            message?: string;
          };
          throw new HttpError(
            capability.status,
            capability.status === 404
              ? "Server upgrade required for safe bridge retries; update Konfab before rejoining"
              : (error.message ?? `Request failed: ${capability.status}`),
          );
        }
        const version = (await capability.json()) as {
          durable_receipts?: number;
          bridge_protocol?: number;
        };
        if (
          version.durable_receipts !== 1 ||
          (version.bridge_protocol ?? 1) < BRIDGE_PROTOCOL_VERSION
        )
          throw new HttpError(
            409,
            "Incompatible server protocol; update Konfab",
          );
        protocolChecked = true;
      }
      return fetch(new URL(path, options.baseUrl), {
        method: "POST",
        headers: {
          "X-Konfab-Request-Id": requestKey,
          "X-Konfab-Protocol": String(BRIDGE_PROTOCOL_VERSION),
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([
              signal,
              AbortSignal.timeout(Math.max(1, deadline - Date.now())),
            ])
          : AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    };
    // Mutations use stable turn/proposal IDs or durable server receipts.
    const repeatSafe = new Set([
      "/agent/join",
      "/agent/permission",
      "/agent/report",
      "/agent/post",
      "/agent/pass",
      "/agent/hand-off",
      "/agent/wait",
      "/agent/wait-finished",
      "/agent/history",
      "/agent/read-role",
      "/agent/read-role-file",
      "/agent/read-skill-file",
      "/agent/decisions/read",
      "/agent/decisions/propose",
      "/agent/permission/wait",
    ]).has(path);
    const deadline =
      Date.now() +
      (path === "/agent/wait" ? 25_000 : (options.retryTimeoutMs ?? 60_000));
    let retryDelay = CONNECTION_RETRY_MS;
    while (true) {
      try {
        const response = await send();
        if (repeatSafe && [502, 503, 504].includes(response.status)) {
          await response.body?.cancel();
          throw new TypeError(
            `Server temporarily unavailable (${response.status})`,
          );
        }
        const payload = (await response.json()) as { message?: string };
        if (!response.ok) {
          throw new HttpError(
            response.status,
            payload.message ?? `Request failed: ${response.status}`,
          );
        }
        return payload as T;
      } catch (error) {
        if (
          !repeatSafe ||
          path === "/agent/wait" ||
          error instanceof HttpError ||
          signal?.aborted
        )
          throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `Konfab unreachable for ${(options.retryTimeoutMs ?? 60_000) / 1000} s; this request was not confirmed. The session may still be available. Say 'continue the loop' once Konfab is back.`,
            { cause: error },
          );
        await delay(
          Math.min(retryDelay, Math.max(0, deadline - Date.now())),
          signal ?? new AbortController().signal,
        );
        retryDelay = Math.min(retryDelay * 2, RETRY_DELAY_MS);
      }
    }
  };

  const server = new McpServer({ name: "konfab", version: "0.1.0" });

  server.registerTool(
    "read_role",
    {
      description: "Read your currently assigned role context.",
      inputSchema: { session_id: z.string() },
    },
    async (body, extra) => {
      try {
        return asToolResult(await call("/agent/read-role", body, extra.signal));
      } catch (error) {
        return asToolError(error);
      }
    },
  );
  server.registerTool(
    "read_role_file",
    {
      description:
        "Read a bounded chunk of a file from your assigned role revision.",
      inputSchema: {
        session_id: z.string(),
        role_revision_id: z.string().uuid(),
        path: z.string(),
        offset: z.number().int().nonnegative().optional(),
        max_bytes: z.number().int().min(1).max(131072).optional(),
      },
    },
    async (body, extra) => {
      try {
        return asToolResult(
          await call("/agent/read-role-file", body, extra.signal),
        );
      } catch (error) {
        return asToolError(error);
      }
    },
  );
  server.registerTool(
    "read_skill_file",
    {
      description:
        "Read a bounded chunk from a skill pinned by your assigned role.",
      inputSchema: {
        session_id: z.string(),
        skill_revision_id: z.string().uuid(),
        path: z.string(),
        offset: z.number().int().nonnegative().optional(),
        max_bytes: z.number().int().min(1).max(131072).optional(),
      },
    },
    async (body, extra) => {
      try {
        return asToolResult(
          await call("/agent/read-skill-file", body, extra.signal),
        );
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "join_room",
    {
      description:
        "Join a Konfab room. Returns a session_id to use with the other tools, plus the room topic, rules, members, and recent messages.",
      inputSchema: { room: z.string().describe("Room name") },
    },
    async ({ room }, extra) => {
      try {
        return asToolResult(await call("/agent/join", { room }, extra.signal));
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
      const callId = randomUUID();
      const finish = async () => {
        try {
          await call(
            "/agent/wait-finished",
            { session_id, call_id: callId },
            AbortSignal.timeout(2000),
          );
        } catch {
          /* Telemetry must not interrupt turn-taking. */
        }
      };
      let waitSeconds = options.defaultWaitSeconds ?? DEFAULT_WAIT_SECONDS;
      let first = true;
      let progress = 0;
      let runWindowNotice: string | undefined;
      const progressToken = extra._meta?.progressToken;

      try {
        while (!extra.signal.aborted) {
          const remaining = waitSeconds - (Date.now() - started) / 1000;
          if (remaining <= 0) break;
          const timeout = Math.min(SERVER_POLL_SECONDS, remaining);

          try {
            const result = await call<{
              status: string;
              wait_seconds: number;
              run_window_notice?: string;
            }>(
              "/agent/wait",
              { session_id, first, call_id: callId, timeout_seconds: timeout },
              extra.signal,
            );
            runWindowNotice = result.run_window_notice;
            first = false;
            waitSeconds = result.wait_seconds;
            if (result.status !== "idle") {
              await finish();
              return asToolResult(result);
            }
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
        if (!extra.signal.aborted) await finish();
        return asToolResult({
          status: "idle",
          ...(runWindowNotice ? { run_window_notice: runWindowNotice } : {}),
        });
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "post_message",
    {
      description:
        "Post your reply to the room. This ends your turn. Set next to self, agent, lead, or done. Use @name to hand work to another member. If the result warns that no continuation is queued and someone should act next, use hand_off with the returned message ID. Then call wait_for_turn again.",
      inputSchema: {
        session_id: z.string(),
        turn_id: z.number().int().positive(),
        body: z.string().describe("Message text"),
        next: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("self") }),
            z.object({ kind: z.literal("agent"), agent_id: z.string().min(1) }),
            z.object({ kind: z.literal("lead") }),
            z.object({ kind: z.literal("done") }),
          ])
          .optional(),
      },
    },
    async ({ session_id, turn_id, body, next }, extra) => {
      try {
        return asToolResult(
          await call(
            "/agent/post",
            { session_id, turn_id, body, ...(next ? { next } : {}) },
            extra.signal,
          ),
        );
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "hand_off",
    {
      description:
        "Repair a missed handoff after posting: explicitly queue another live room member using your latest agent message from the last 10 minutes. Repeats for the same source and target are deduplicated. Use only when work should continue; then call wait_for_turn.",
      inputSchema: {
        session_id: z.string(),
        source_message_id: z.number().int().positive(),
        to: z.string().min(1).describe("Member agent who should act next"),
      },
    },
    async ({ session_id, source_message_id, to }, extra) => {
      try {
        return asToolResult(
          await call(
            "/agent/hand-off",
            { session_id, source_message_id, to },
            extra.signal,
          ),
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
    async ({ session_id, turn_id, reason }, extra) => {
      try {
        return asToolResult(
          await call(
            "/agent/pass",
            {
              session_id,
              turn_id,
              ...(reason ? { reason } : {}),
            },
            extra.signal,
          ),
        );
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "propose_decision",
    {
      description:
        "Propose a room decision for the lead to confirm or reject. Proposals do not apply until confirmed.",
      inputSchema: {
        session_id: z.string(),
        body: z.string().min(1).max(2000),
        source_message_id: z.number().int().positive().optional(),
      },
    },
    async ({ session_id, body, source_message_id }) => {
      try {
        return asToolResult(
          await call("/agent/decisions/propose", {
            session_id,
            body,
            proposal_key: randomUUID(),
            ...(source_message_id ? { source_message_id } : {}),
          }),
        );
      } catch (error) {
        return asToolError(error);
      }
    },
  );

  server.registerTool(
    "read_decisions",
    {
      description:
        "Read current confirmed decisions for your room. Use next_after_id to fetch more.",
      inputSchema: {
        session_id: z.string(),
        after_id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ session_id, after_id, limit }) => {
      try {
        return asToolResult(
          await call("/agent/decisions/read", {
            session_id,
            ...(after_id ? { after_id } : {}),
            ...(limit ? { limit } : {}),
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
        "Report working with a short one-line detail before work outside your turn. Posting or passing clears it. Other kinds report problems or low allowance.",
      inputSchema: {
        session_id: z.string(),
        kind: z.enum(["low_allowance", "out_of_allowance", "other", "working"]),
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
        'Ask the user before sending file contents, conversation content, secrets, or personal data to anyone other than Anthropic, OpenAI, Meta, or xAI. Do not send anything unless the state is "approved". If the state is "pending", call this again with the same session_id and the request_id you received. An approval covers only this recipient and data. For code_push provide push_scope with repository, branch, and full base and head commit IDs. Before pushing, check that the repo, branch, and base..head match this approval exactly; if anything changed, request again.',
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
        push_scope: z
          .object({
            repository: z.string(),
            branch: z.string(),
            base: z.string(),
            head: z.string(),
          })
          .optional()
          .describe(
            "Required for code_push: repository matching recipient, branch, and full base and head commit IDs",
          ),
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
            extra.signal,
          );
          if (created.state !== "pending")
            return asToolResult(toPermission(created));
          id = created.id;
        }

        const started = Date.now();
        let waitSeconds = DEFAULT_WAIT_SECONDS;
        let latest: {
          id: number;
          state: string;
          data_type?: string | null;
          wait_seconds: number;
          recipient?: string;
          data_description?: string;
          push_repository?: string | null;
          push_branch?: string | null;
          push_base?: string | null;
          push_head?: string | null;
        };
        do {
          latest = await call<{
            id: number;
            state: string;
            data_type?: string | null;
            wait_seconds: number;
            recipient?: string;
            data_description?: string;
            push_repository?: string | null;
            push_branch?: string | null;
            push_base?: string | null;
            push_head?: string | null;
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
