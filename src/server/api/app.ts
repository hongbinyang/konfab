import { randomUUID } from "node:crypto";
import { BRIDGE_PROTOCOL_VERSION } from "../../protocol.js";
import fastifyStatic from "@fastify/static";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Writable } from "node:stream";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z, ZodError } from "zod";
import { SkillError } from "../domain/skill-error.js";
import type { SkillLibrary } from "../domain/skills.js";
import type { SkillSources } from "../domain/skill-sources.js";
import type { Route, SendResult } from "../domain/rejoin.js";
import { RefusedWatch, type Watchers } from "../rejoin/watchers.js";
import { KonfabError, type KonfabService } from "../domain/service.js";
import type { NoticesView, TelegramNotices } from "../telegram/notices.js";

const MAX_SERVER_WAIT_SECONDS = 30;
const SESSION_COOKIE = "konfab_session";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const session = { session_id: z.string().min(1) };
const turn = { ...session, turn_id: z.number().int().positive() };
const timeout = z.number().min(0).max(MAX_SERVER_WAIT_SECONDS).default(20);

const joinBody = z.object({
  room: z.string().min(1),
  as: z.string().min(1).optional(),
});
const waitBody = z.object({
  ...session,
  first: z.boolean().default(false),
  call_id: z.string().uuid().optional(),
  timeout_seconds: timeout,
});
const nextAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("self") }),
  z.object({ kind: z.literal("agent"), agent_id: z.string().min(1) }),
  z.object({ kind: z.literal("lead") }),
  z.object({ kind: z.literal("done") }),
]);
const postBody = z.object({
  ...turn,
  body: z.string(),
  next: nextAction.optional(),
});
const passBody = z.object({ ...turn, reason: z.string().optional() });
const historyBody = z.object({
  ...session,
  before_id: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
const reportBody = z.object({
  ...session,
  kind: z.enum([
    "low_allowance",
    "out_of_allowance",
    "other",
    "working",
    "blocked",
  ]),
  detail: z.string().default(""),
});
const permissionBody = z.object({
  ...session,
  recipient: z.string().trim().min(1).max(500),
  data_description: z.string().trim().min(1).max(2000),
  reason: z.string().trim().min(1).max(2000),
  data_type: z.string().trim().min(1).max(100).optional(),
  push_scope: z
    .object({
      repository: z.string().trim().min(1).max(500),
      branch: z.string().trim().min(1).max(500),
      base: z.string().max(64),
      head: z.string().max(64),
    })
    .optional(),
});
const permissionWaitBody = z.object({
  ...session,
  request_id: z.number().int().positive(),
  timeout_seconds: timeout,
});

const idParams = z.object({ id: z.coerce.number().int().positive() });
const createRoomBody = z.object({
  name: z.string(),
  topic: z.string().default(""),
  members: z.array(z.string()).default([]),
});
const updateRoomBody = z.object({
  name: z.string().optional(),
  topic: z.string().optional(),
  brief: z.string().optional(),
  project_path: z.string().nullable().optional(),
  parallel_lead_mentions: z.boolean().optional(),
  checkin_minutes: z
    .union([z.literal(1), z.literal(2), z.literal(5), z.literal(10)])
    .nullable()
    .optional(),
});
const memberParams = z.object({
  id: z.coerce.number().int().positive(),
  agentId: z.string().min(1),
});
const membersBody = z.object({ members: z.array(z.string()) });
const pauseBody = z.object({ paused: z.boolean() });
const userMessageBody = z.object({
  body: z.string(),
  attachment_ids: z.array(z.string().uuid()).max(20).default([]),
});
const decisionBody = z.object({ decision: z.enum(["approved", "denied"]) });
const loginQuery = z.object({ code: z.string().min(1) });
const searchQuery = z.object({ q: z.string().trim().min(1).max(200) });
const extendBody = z.object({ minutes: z.number().int().min(1).max(1440) });

export interface AppOptions {
  service: KonfabService;
  notices?: TelegramNotices;
  sendRejoin?: (conversation: string, number: string) => Promise<SendResult>;
  /** Brings an app to the front; whether the command worked. */
  openApp?: (app: "codex" | "claude") => Promise<boolean>;
  watchers?: Watchers;
  skills?: SkillLibrary;
  sources?: SkillSources;
  skillsHome?: string;
  port: number;
  webDir?: string;
  logger?: boolean;
  logStream?: Writable;
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { service, port, webDir } = options;
  const instanceId = randomUUID();
  const app = Fastify({
    logger: options.logger
      ? {
          ...(options.logStream ? { stream: options.logStream } : {}),
          // Paths only, because a sign-in link carries a code in its query.
          serializers: {
            req: (request) => ({
              method: request.method,
              url: request.url.split("?")[0],
            }),
          },
        }
      : false,
    // The page and the agents ask all the time; see onResponse below.
    logController: new LogController({ disableRequestLogging: true }),
    forceCloseConnections: true,
  });
  // Changes and problems only, so the log isn't filled by routine requests.
  app.addHook("onResponse", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const routine =
      request.method === "GET" ||
      /^\/(agent\/(wait|watch|permission\/wait)|api\/activity)/.test(path);
    const { statusCode } = reply;
    if (statusCode < 400 && routine && path !== "/login") return;
    const entry = {
      req: request,
      statusCode,
      ms: Math.round(reply.elapsedTime),
    };
    if (statusCode >= 500) request.log.error(entry, "request failed");
    else if (statusCode >= 400) request.log.warn(entry, "request refused");
    else request.log.info(entry, "request");
  });

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set(
    [...allowedHosts].map((host) => `http://${host}`),
  );

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (
      !allowedHosts.has(request.headers.host ?? "") ||
      (origin !== undefined && !allowedOrigins.has(origin))
    ) {
      return reply
        .code(403)
        .send({ code: "forbidden", message: "Request not allowed" });
    }
    if (request.url.startsWith("/api/")) {
      const token = readCookie(request, SESSION_COOKIE);
      if (!token || !service.isWebSessionValid(token)) {
        return reply
          .code(401)
          .send({ code: "unauthorized", message: "Sign in to continue" });
      }
    }
  });

  app.addHook("onSend", async (_request, reply: FastifyReply) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });

  app.setErrorHandler((error, request, reply) => {
    const libraryRequest =
      /^\/api\/(?:library(?:\/|\?|$)|roles(?:\/|\?|$)|rooms\/[^/]+\/members(?:\/|\?|$))/.test(
        request.url,
      );
    if (error instanceof SkillError) {
      const { pin, local } = error as SkillError & {
        pin?: number;
        local?: unknown;
      };
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
        ...(pin !== undefined ? { pin } : {}),
        ...(local !== undefined ? { local } : {}),
      });
    }
    if (error instanceof KonfabError) {
      if (error.code === "session_stopped") {
        const body = request.body as { session_id?: unknown } | null;
        const key = request.headers["x-konfab-request-id"];
        if (typeof body?.session_id === "string")
          service.stops.refusedCall(
            body.session_id,
            typeof key === "string" ? key : undefined,
          );
      }
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 413
    )
      return reply.code(413).send({
        code: "attachment_too_large",
        message: "File exceeds the attachment size limit",
      });
    if (error instanceof ZodError) {
      const message = libraryRequest
        ? error.issues
            .map((issue) => {
              const field = issue.path.length
                ? issue.path.join(".")
                : "request";
              if (issue.code === "too_small")
                return issue.origin === "string" && issue.minimum === 1
                  ? `${field}: required; enter at least 1 character.`
                  : `${field}: must contain at least ${issue.minimum} ${issue.origin === "string" ? "characters" : "items"}.`;
              if (issue.code === "too_big")
                return `${field}: must contain at most ${issue.maximum} ${issue.origin === "string" ? "characters" : "items"}.`;
              if (issue.code === "invalid_type")
                return `${field}: required; enter a valid ${issue.expected}.`;
              return `${field}: ${issue.message}`;
            })
            .join("; ")
        : "Invalid request";
      return reply.code(400).send({ code: "invalid_request", message });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.code(400).send({
        code: "invalid_request",
        message: libraryRequest
          ? "Request could not be read; check the submitted data and try again."
          : "Invalid request",
      });
    app.log.error(error);
    return reply
      .code(500)
      .send({ code: "internal_error", message: "Internal error" });
  });

  // Page sign-in

  app.get("/login", async (request, reply) => {
    const { code } = loginQuery.parse(request.query);
    const token = service.redeemLoginCode(code);
    reply.header(
      "Set-Cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    );
    return reply.redirect("/", 303);
  });

  // Agent routes, used only by the bridge

  const requireApp = (request: FastifyRequest): string => {
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    const appId = match?.[1] ? service.authenticateAgent(match[1]) : null;
    if (!appId)
      throw new KonfabError("unauthorized", 401, "Invalid agent token");
    return appId;
  };
  const requireAgent = (request: FastifyRequest): string => {
    const appId = requireApp(request);
    const path = request.url.split("?")[0];
    if (
      path === "/agent/join" ||
      path === "/agent/rejoin" ||
      path === "/agent/protocol"
    )
      return service.appAgent(appId);
    const body = request.body as { session_id?: unknown } | null;
    if (typeof body?.session_id !== "string" || !body.session_id)
      throw new KonfabError("session_required", 400, "session_id required");
    return service.sessionAgent(appId, body.session_id);
  };

  const isWatch = (request: FastifyRequest): boolean =>
    /^\/agent\/watch(\/printed)?$/.test(request.url.split("?")[0] ?? "");
  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/agent/")) return;
    // A watcher's own ticket, which is good for nothing else.
    if (isWatch(request)) return;
    const agentId = requireAgent(request);
    const protocol =
      request.headers["x-konfab-protocol"] === String(BRIDGE_PROTOCOL_VERSION)
        ? BRIDGE_PROTOCOL_VERSION
        : 0;
    service.recordBridgeProtocol(agentId, protocol);
  });

  app.get("/agent/protocol", async (request) => {
    requireAgent(request);
    return { durable_receipts: 1, bridge_protocol: BRIDGE_PROTOCOL_VERSION };
  });

  /** From the connector, as the app named it. Not proof of anything. */
  const conversationOf = (
    request: FastifyRequest,
  ): { conversation: unknown; route: Route } => {
    const watched = request.headers["x-konfab-watched-conversation"];
    if (watched === undefined)
      return {
        conversation: request.headers["x-konfab-conversation"],
        route: "queue",
      };
    return {
      conversation: options.watchers?.enabled ? watched : undefined,
      route: "watch",
    };
  };
  /** What an agent may start so that its app can wake it. Never in the way. */
  const withWatcher = <T extends object>(
    request: FastifyRequest,
    appId: string,
    agentId: string,
    reply: T,
  ): T => {
    const { conversation, route } = conversationOf(request);
    if (route !== "watch") return reply;
    try {
      const watcher = options.watchers?.offer(appId, agentId, conversation);
      return watcher ? { ...reply, watcher } : reply;
    } catch (error) {
      request.log.warn({ err: error }, "no watcher was offered");
      return reply;
    }
  };
  const repeatMutation = <T>(
    request: FastifyRequest,
    agentId: string,
    action: () => T,
  ): T => {
    const rawKey = request.headers["x-konfab-request-id"];
    if (rawKey === undefined) return action(); // Older bridges remain compatible.
    const key = z.string().uuid().parse(rawKey);
    return service.repeatRequest(
      agentId,
      key,
      JSON.stringify({ path: request.url, body: request.body }),
      action,
    );
  };

  const noticeRoutes = new Set([
    "/agent/post",
    "/agent/pass",
    "/agent/hand-off",
    "/agent/decisions/propose",
    "/agent/permission",
    "/agent/permission/wait",
    "/agent/report",
    "/agent/lock/acquire",
    "/agent/lock/release",
    "/agent/history",
    "/agent/decisions/read",
    "/agent/read-role",
    "/agent/read-assignment",
    "/agent/read-role-file",
    "/agent/read-skill-file",
  ]);
  const endingTurnNotices = new WeakMap<
    FastifyRequest,
    ReturnType<KonfabService["pendingLeadMessages"]>
  >();
  app.addHook("preHandler", async (request) => {
    if (!["/agent/post", "/agent/pass"].includes(request.url.split("?")[0]!))
      return;
    const sessionId = (request.body as { session_id?: unknown } | null)
      ?.session_id;
    if (typeof sessionId !== "string") return;
    try {
      endingTurnNotices.set(
        request,
        service.pendingLeadMessages(requireAgent(request), sessionId),
      );
    } catch {
      /* Route will handle authentication and session errors. */
    }
  });
  app.addHook("preSerialization", async (request, reply, payload) => {
    if (
      !noticeRoutes.has(request.url.split("?")[0]!) ||
      reply.statusCode >= 400 ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      return payload;
    const sessionId = (request.body as { session_id?: unknown } | null)
      ?.session_id;
    if (typeof sessionId !== "string") return payload;
    try {
      const notices = service.pendingLeadMentions(
        requireAgent(request),
        sessionId,
      );
      const leadMessages =
        endingTurnNotices.get(request) ??
        service.pendingLeadMessages(requireAgent(request), sessionId);
      return notices.length || leadMessages
        ? {
            ...payload,
            ...(leadMessages
              ? {
                  lead_messages: leadMessages,
                  lead_messages_note:
                    "New lead messages are room context, not necessarily addressed to you. You may acknowledge them in a working status detail. They repeat until a later turn includes them.",
                }
              : {}),
            ...(notices.length
              ? {
                  lead_mentions: notices,
                  lead_mentions_note:
                    "A lead mention is queued; notices repeat until its turn begins. You may acknowledge it in a working status detail without ending your turn.",
                }
              : {}),
          }
        : payload;
    } catch {
      return payload;
    }
  });

  app.post("/agent/join", async (request) => {
    const appId = requireApp(request);
    const body = joinBody.parse(request.body);
    const agentId = service.appAgent(appId, body.as);
    const { conversation, route } = conversationOf(request);
    return repeatMutation(request, agentId, () =>
      withWatcher(
        request,
        appId,
        agentId,
        service.join(agentId, body.room, conversation, route),
      ),
    );
  });

  // Repeating it is safe by itself, so its number is in no stored receipt.
  app.post("/agent/rejoin", async (request) => {
    const appId = requireApp(request);
    const { request: number } = z
      .object({ request: z.string().max(200) })
      .parse(request.body);
    const { conversation, route } = conversationOf(request);
    const reply = service.rejoin.rejoin(appId, number, conversation, route);
    const session = (reply as { session_id?: string }).session_id;
    return session
      ? withWatcher(request, appId, service.sessionAgent(appId, session), reply)
      : reply;
  });

  const ticketOf = (request: FastifyRequest): string | undefined =>
    /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
  const refuseWatch = (error: unknown): never => {
    if (error instanceof RefusedWatch)
      throw new KonfabError("unauthorized", 401, "Not accepted");
    throw error;
  };
  app.post(
    "/agent/watch",
    { bodyLimit: 1024 },
    async (request, reply): Promise<object> => {
      if (!options.watchers) return refuseWatch(new RefusedWatch());
      const gone = new AbortController();
      reply.raw.once("close", () => gone.abort());
      try {
        const { pid } = z.object({ pid: z.number() }).parse(request.body);
        return await options.watchers.watch(
          ticketOf(request),
          pid,
          gone.signal,
        );
      } catch (error) {
        return refuseWatch(error);
      }
    },
  );
  app.post("/agent/watch/printed", { bodyLimit: 1024 }, async (request) => {
    try {
      if (!options.watchers) throw new RefusedWatch();
      const { handover } = z
        .object({ handover: z.string().max(100) })
        .parse(request.body);
      options.watchers.printed(ticketOf(request), handover);
      return { ok: true };
    } catch (error) {
      return refuseWatch(error);
    }
  });

  app.post("/agent/wait", async (request) => {
    const agentId = requireAgent(request);
    const body = waitBody.parse(request.body);
    if (body.call_id)
      service.beginObservedWait(agentId, body.session_id, body.call_id);
    const result = await service.waitForTurn(
      agentId,
      body.session_id,
      body.first,
      body.timeout_seconds * 1000,
    );
    if (result.status === "closed" && result.reason === "stopped")
      service.stops.answeredWait(body.session_id, body.call_id);
    return result;
  });

  // The connector has an answer that says "stop". It changes nothing else.
  app.post("/agent/stop-received", async (request) => {
    requireAgent(request);
    const body = z.object(session).parse(request.body);
    service.stops.received(body.session_id);
    return { ok: true };
  });

  app.post("/agent/wait-finished", async (request) => {
    const agentId = requireAgent(request);
    const body = z
      .object({ ...session, call_id: z.string().uuid() })
      .parse(request.body);
    service.finishObservedWait(agentId, body.session_id, body.call_id);
    return { ok: true };
  });

  app.post("/agent/post", async (request) => {
    const agentId = requireAgent(request);
    const body = postBody.parse(request.body);
    return service.postAgentMessage(
      agentId,
      body.session_id,
      body.turn_id,
      body.body,
      body.next,
    );
  });

  app.post("/agent/hand-off", async (request) => {
    const agentId = requireAgent(request);
    const body = z
      .object({
        ...session,
        source_message_id: z.number().int().positive(),
        to: z.string().min(1),
      })
      .parse(request.body);
    return service.handOff(
      agentId,
      body.session_id,
      body.source_message_id,
      body.to,
    );
  });

  app.post("/agent/pass", async (request) => {
    const agentId = requireAgent(request);
    const body = passBody.parse(request.body);
    return service.passTurn(
      agentId,
      body.session_id,
      body.turn_id,
      body.reason,
    );
  });

  app.post("/agent/decisions/propose", async (request) => {
    const agent = requireAgent(request);
    const body = z
      .object({
        ...session,
        body: z.string().trim().min(1).max(2000),
        proposal_key: z.string().uuid(),
        source_message_id: z.number().int().positive().optional(),
      })
      .parse(request.body);
    return service.proposeDecision(
      agent,
      body.session_id,
      body.body,
      body.proposal_key,
      body.source_message_id,
    );
  });

  app.post("/agent/decisions/read", async (request) => {
    const agent = requireAgent(request);
    const body = z
      .object({
        ...session,
        after_id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .parse(request.body);
    return service.readDecisions(
      agent,
      body.session_id,
      body.after_id,
      body.limit,
    );
  });

  app.post("/agent/history", async (request) => {
    const agentId = requireAgent(request);
    const body = historyBody.parse(request.body);
    return service.readHistory(
      agentId,
      body.session_id,
      body.before_id,
      body.limit,
    );
  });

  app.post("/agent/report", async (request) => {
    const agentId = requireAgent(request);
    const body = reportBody.parse(request.body);
    return repeatMutation(request, agentId, () =>
      service.reportStatus(agentId, body.session_id, body.kind, body.detail),
    );
  });

  app.post("/agent/lock/acquire", async (request) => {
    const agentId = requireAgent(request);
    const body = z
      .object({
        ...session,
        resource: z.string().min(1).max(1000),
        purpose: z.string().min(1).max(300),
        lease_minutes: z.number().int().min(1).max(240).default(30),
      })
      .parse(request.body);
    return repeatMutation(request, agentId, () =>
      service.acquireLock(
        agentId,
        body.session_id,
        body.resource,
        body.purpose,
        body.lease_minutes,
      ),
    );
  });
  app.post("/agent/lock/release", async (request) => {
    const agentId = requireAgent(request);
    const body = z
      .object({ ...session, resource: z.string().min(1).max(1000) })
      .parse(request.body);
    return repeatMutation(request, agentId, () =>
      service.releaseLock(agentId, body.session_id, body.resource),
    );
  });

  app.post("/agent/read-role", async (request) => {
    const agentId = requireAgent(request);
    const body = z.object(session).parse(request.body);
    return service.readAssignedRole(agentId, body.session_id);
  });
  app.post("/agent/read-assignment", async (request) => {
    const agentId = requireAgent(request);
    const body = z.object(session).parse(request.body);
    return { assignment: service.readAssignment(agentId, body.session_id) };
  });
  app.post("/agent/read-role-file", async (request) => {
    const agentId = requireAgent(request);
    const body = z
      .object({
        ...session,
        role_revision_id: z.string().uuid(),
        path: z.string().min(1).max(512),
        offset: z.number().int().nonnegative().default(0),
        max_bytes: z.number().int().min(1).max(131072).default(32768),
      })
      .parse(request.body);
    return service.readAssignedRoleFile(
      agentId,
      body.session_id,
      body.role_revision_id,
      body.path,
      body.offset,
      body.max_bytes,
    );
  });
  app.post("/agent/read-skill-file", async (request) => {
    const agentId = requireAgent(request);
    const body = z
      .object({
        ...session,
        skill_revision_id: z.string().uuid(),
        path: z.string().min(1).max(512),
        offset: z.number().int().nonnegative().default(0),
        max_bytes: z.number().int().min(1).max(131072).default(32768),
      })
      .parse(request.body);
    return service.readAssignedSkillFile(
      agentId,
      body.session_id,
      body.skill_revision_id,
      body.path,
      body.offset,
      body.max_bytes,
    );
  });

  app.post("/agent/permission", async (request) => {
    const agentId = requireAgent(request);
    const { session_id: sessionId, ...details } = permissionBody.parse(
      request.body,
    );
    return repeatMutation(request, agentId, () =>
      service.requestPermission(agentId, sessionId, details),
    );
  });

  app.post("/agent/permission/wait", async (request) => {
    const agentId = requireAgent(request);
    const body = permissionWaitBody.parse(request.body);
    const answer = await service.waitForPermission(
      agentId,
      body.session_id,
      body.request_id,
      body.timeout_seconds * 1000,
    );
    return { ...answer, wait_seconds: service.waitSeconds };
  });

  // Page routes

  const skillService = () => {
    if (!options.skills || !options.skillsHome)
      throw new KonfabError("unavailable", 503, "Library unavailable");
    return options.skills;
  };
  const sourceService = () => {
    if (!options.sources)
      throw new KonfabError("unavailable", 503, "Public sources unavailable");
    return options.sources;
  };
  const sourceId = z.object({ sourceId: z.string().uuid() });
  app.get("/api/library/sources", async () => ({
    sources: sourceService().list(),
    token: sourceService().tokenState(),
    github: sourceService().githubStatus(),
  }));
  app.post("/api/library/github-status/check", async () =>
    sourceService().checkGithub(),
  );
  app.post("/api/library/sources", async (request) => {
    const body = z
      .object({
        owner: z.string().min(1).max(100),
        repository: z.string().min(1).max(100),
        ref: z.string().min(1).max(200).default("HEAD"),
      })
      .parse(request.body);
    return { id: sourceService().add(body.owner, body.repository, body.ref) };
  });
  app.put("/api/library/sources/:sourceId", async (request) => {
    const { sourceId: id } = sourceId.parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    sourceService().setEnabled(id, enabled);
    return { ok: true };
  });
  app.get("/api/library/legacy-indexes", async () => ({
    bytes: sourceService().legacyIndexSize(),
  }));
  app.delete("/api/library/legacy-indexes", async () => {
    sourceService().removeLegacyIndexes();
    return { ok: true };
  });
  app.get("/api/library/live", async (request) => {
    const { q } = z
      .object({ q: z.string().max(200).default("") })
      .parse(request.query);
    return sourceService().live.search(q);
  });
  app.get("/api/library/live/preview", async (request) => {
    const query = z
      .object({
        source_id: z.string().uuid(),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        path: z.string().min(1).max(1024),
      })
      .parse(request.query);
    return sourceService().live.preview(
      query.source_id,
      query.commit,
      query.path,
    );
  });
  app.get("/api/library/live/file", async (request) => {
    const query = z
      .object({
        source_id: z.string().uuid(),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        path: z.string().min(1).max(1024),
        file: z.string().min(1).max(1024),
      })
      .parse(request.query);
    return {
      content_base64: await sourceService().live.previewFile(
        query.source_id,
        query.commit,
        query.path,
        query.file,
      ),
    };
  });
  app.put("/api/library/source-token", async (request) => {
    const { enabled, acknowledged } = z
      .object({
        enabled: z.boolean(),
        acknowledged: z.boolean().default(false),
      })
      .parse(request.body);
    if (enabled && !acknowledged)
      throw new SkillError(
        "token_consent_required",
        400,
        "Confirm before sending the token to GitHub",
      );
    sourceService().setTokenEnabled(enabled);
    return sourceService().tokenState();
  });
  const skillScope = (
    scope: "personal" | "project",
    roomId?: number,
    create = false,
  ) => {
    const library = skillService();
    const project =
      scope === "project" && roomId
        ? service.roomState(roomId).room.project_path
        : null;
    if (scope === "project" && !project)
      throw new KonfabError(
        "project_missing",
        400,
        "Set a project folder first",
      );
    const parent = scope === "personal" ? options.skillsHome! : project!;
    if (!existsSync(parent) || !lstatSync(parent).isDirectory()) {
      if (scope === "project" && !create)
        return {
          library,
          libraryId: library.findLibrary(join(parent, ".konfab", "skills")),
        };
      throw new KonfabError("unavailable", 404, "Library root unavailable");
    }
    const parts = scope === "personal" ? ["skills"] : [".konfab", "skills"];
    let path = parent;
    for (const part of parts) {
      path = join(path, part);
      if (!existsSync(path)) {
        if (!create)
          return {
            library,
            libraryId:
              scope === "project"
                ? library.findLibrary(join(parent, ".konfab", "skills"))
                : null,
          };
        mkdirSync(path, { mode: 0o700 });
      }
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new KonfabError(
          "invalid_library",
          400,
          "Library folder is unavailable",
        );
    }
    return { library, libraryId: library.registerLibrary(scope, path) };
  };
  const scopeQuery = z.object({
    scope: z.enum(["personal", "project"]).default("personal"),
    room_id: z.coerce.number().int().positive().optional(),
    trash: z.enum(["true", "false"]).default("false"),
  });
  app.get("/api/library", async (request) => {
    const query = scopeQuery.parse(request.query);
    const { library, libraryId } = skillScope(query.scope, query.room_id);
    return libraryId
      ? library.list(libraryId, query.trash === "true")
      : { skills: [], untracked: [] };
  });
  app.post("/api/library/skills", async (request) => {
    const body = z
      .object({
        scope: z.enum(["personal", "project"]),
        room_id: z.number().int().positive().optional(),
        name: z.string().min(1).max(128),
        description: z.string().min(1).max(2048),
      })
      .parse(request.body);
    const { library, libraryId } = skillScope(body.scope, body.room_id, true);
    if (!libraryId)
      throw new KonfabError("unavailable", 404, "Library unavailable");
    return skillAction(() => ({
      id: library.create(libraryId, body.name, body.description),
    }));
  });
  app.post("/api/library/adopt", async (request) => {
    const body = z
      .object({
        scope: z.enum(["personal", "project"]),
        room_id: z.number().int().positive().optional(),
        folder: z.string().max(128),
      })
      .parse(request.body);
    const { library, libraryId } = skillScope(body.scope, body.room_id);
    if (!libraryId)
      throw new KonfabError(
        "unavailable",
        404,
        "Library folder is unavailable",
      );
    return skillAction(() => ({ id: library.adopt(libraryId, body.folder) }));
  });

  const skillId = z.object({ id: z.string().uuid() });
  const localUpload = z.object({
    scope: z.enum(["personal", "project"]),
    room_id: z.number().int().positive().optional(),
    source_name: z.string().min(1).max(512),
    single_file: z.boolean(),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(1024),
          content_base64: z.string().max(1_000_000),
        }),
      )
      .min(1)
      .max(1100),
    skill_file: z.string().max(512).optional(),
    leave_out: z.array(z.string().max(512)).max(1100).optional(),
    name: z.string().max(128).optional(),
  });
  const importLibrary = (scope: "personal" | "project", roomId?: number) => {
    const { library, libraryId } = skillScope(scope, roomId, true);
    if (!libraryId)
      throw new KonfabError("unavailable", 404, "Library unavailable");
    return { library, libraryId };
  };
  app.post(
    "/api/library/import/preview",
    { bodyLimit: 4_000_000 },
    async (request) => {
      const body = localUpload.parse(request.body);
      const { library, libraryId } = importLibrary(body.scope, body.room_id);
      return skillAction(() => {
        const preview: Partial<ReturnType<typeof library.prepareLocalImport>> =
          library.prepareLocalImport(libraryId, body, body.name || undefined);
        delete preview.package;
        return preview;
      });
    },
  );
  app.post("/api/library/import", { bodyLimit: 4_000_000 }, async (request) => {
    const body = localUpload
      .extend({
        name: z.string().min(1).max(128),
        action: z.enum(["create", "replace"]),
        expected: z.object({
          package_hash: z.string().regex(/^[a-f0-9]{64}$/),
          collision_revision_id: z.string().uuid().nullable(),
          collision_draft_hash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
        }),
      })
      .parse(request.body);
    const { library, libraryId } = importLibrary(body.scope, body.room_id);
    return skillAction(() =>
      library.importLocal(
        libraryId,
        body,
        body.name,
        body.action,
        body.expected,
      ),
    );
  });
  app.post("/api/library/skills/:id/workspace/resolve", async (request) => {
    const { id } = skillId.parse(request.params);
    const body = z
      .object({
        action: z.enum(["retry", "move_aside", "save_edits"]),
        expected_reason: z.enum([
          "folder_exists",
          "folder_edited",
          "write_failed",
        ]),
        expected_target: z.string().max(200).nullable().optional(),
      })
      .parse(request.body);
    return skillAction(() =>
      skillService().resolveWorkspace(
        id,
        body.action,
        body.expected_reason,
        body.expected_target ?? null,
      ),
    );
  });
  app.get("/api/library/kept", async (request) => {
    const query = scopeQuery.parse(request.query);
    const { library, libraryId } = skillScope(query.scope, query.room_id);
    return { kept: libraryId ? library.keptFolders(libraryId) : [] };
  });
  app.get("/api/library/kept/:id/differences", async (request) => {
    const { id } = skillId.parse(request.params);
    return skillAction(() => ({
      changes: skillService().keptDifferences(id),
    }));
  });
  app.delete("/api/library/kept/:id", async (request) => {
    const { id } = skillId.parse(request.params);
    skillAction(() => skillService().removeKept(id));
    return { ok: true };
  });

  const skillRevisionId = z.object({
    id: z.string().uuid(),
    revisionId: z.string().uuid(),
  });
  const skillMutation = z.object({
    base_revision_id: z.string().uuid(),
    base_draft_hash: z.string().regex(/^[a-f0-9]{64}$/),
  });
  const skillAction = <T>(action: () => T): T => {
    try {
      return action();
    } catch (error) {
      if (error instanceof SkillError || error instanceof KonfabError)
        throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST")
        throw new SkillError(
          "name_conflict",
          409,
          "A file or folder already exists",
        );
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM")
        throw new SkillError(
          "unavailable",
          404,
          "The library or file is unavailable",
        );
      throw error;
    }
  };
  app.get("/api/library/skills/:id", async (request) => {
    const { id } = skillId.parse(request.params);
    return skillAction(() => skillService().detail(id));
  });
  app.get("/api/library/skills/:id/files", async (request) => {
    const { id } = skillId.parse(request.params);
    const { path } = z
      .object({ path: z.string().min(1).max(512) })
      .parse(request.query);
    return skillAction(() => ({
      content_base64: skillService().readFile(id, path).toString("base64"),
    }));
  });
  app.put(
    "/api/library/skills/:id/files",
    { bodyLimit: 800_000 },
    async (request) => {
      const { id } = skillId.parse(request.params);
      const body = skillMutation
        .extend({
          path: z.string().min(1).max(512),
          content_base64: z
            .string()
            .max(700_000)
            .regex(
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            ),
        })
        .parse(request.body);
      return skillAction(() => {
        const draft_hash = skillService().writeFile(
          id,
          body.path,
          Buffer.from(body.content_base64, "base64"),
          body.base_revision_id,
          body.base_draft_hash,
        );
        return { draft_hash };
      });
    },
  );
  app.post("/api/library/skills/:id/files/delete", async (request) => {
    const { id } = skillId.parse(request.params);
    const body = skillMutation
      .extend({ path: z.string().min(1).max(512) })
      .parse(request.body);
    return skillAction(() => ({
      draft_hash: skillService().deleteFile(
        id,
        body.path,
        body.base_revision_id,
        body.base_draft_hash,
      ),
    }));
  });
  app.get("/api/library/skills/:id/revisions", async (request) => {
    const { id } = skillId.parse(request.params);
    return skillAction(() => skillService().revisions(id));
  });
  app.get("/api/library/skills/:id/revisions/:revisionId", async (request) => {
    const { id, revisionId } = skillRevisionId.parse(request.params);
    return skillAction(() => skillService().revisionFiles(id, revisionId));
  });
  app.get(
    "/api/library/skills/:id/revisions/:revisionId/files",
    async (request) => {
      const { id, revisionId } = skillRevisionId.parse(request.params);
      const { path } = z
        .object({ path: z.string().min(1).max(512) })
        .parse(request.query);
      return skillAction(() => ({
        content_base64: skillService()
          .readRevisionFile(id, revisionId, path)
          .toString("base64"),
      }));
    },
  );
  app.post(
    "/api/library/skills/:id/revisions/:revisionId/restore",
    async (request) => {
      const { id, revisionId } = skillRevisionId.parse(request.params);
      const body = skillMutation.parse(request.body);
      return skillAction(() => ({
        revision_id: skillService().restoreRevision(
          id,
          revisionId,
          body.base_revision_id,
          body.base_draft_hash,
        ),
      }));
    },
  );
  app.post("/api/library/skills/:id/rename", async (request) => {
    const { id } = skillId.parse(request.params);
    const body = skillMutation
      .extend({ name: z.string().min(1).max(128) })
      .parse(request.body);
    return skillAction(() => ({
      revision_id: skillService().rename(
        id,
        body.name,
        body.base_revision_id,
        body.base_draft_hash,
      ),
    }));
  });
  app.post("/api/library/skills/:id/duplicate", async (request) => {
    const { id } = skillId.parse(request.params);
    const body = z
      .object({
        revision_id: z.string().uuid(),
        scope: z.enum(["personal", "project"]),
        room_id: z.number().int().positive().optional(),
        name: z.string().min(1).max(128),
      })
      .parse(request.body);
    const { library, libraryId } = skillScope(body.scope, body.room_id, true);
    if (!libraryId)
      throw new KonfabError("unavailable", 404, "Library unavailable");
    return skillAction(() => ({
      id: library.duplicate(id, body.revision_id, libraryId, body.name),
    }));
  });
  app.post("/api/library/skills/:id/save", async (request) => {
    const { id } = skillId.parse(request.params);
    const body = skillMutation.parse(request.body);
    return skillAction(() => ({
      revision_id: skillService().save(
        id,
        body.base_revision_id,
        body.base_draft_hash,
      ),
    }));
  });
  app.post("/api/library/skills/:id/trash", async (request) => {
    const { id } = skillId.parse(request.params);
    const body = skillMutation.parse(request.body);
    return skillAction(() => {
      skillService().trash(id, body.base_revision_id, body.base_draft_hash);
      return { ok: true };
    });
  });
  app.post("/api/library/skills/:id/restore", async (request) => {
    const { id } = skillId.parse(request.params);
    const body = skillMutation.parse(request.body);
    return skillAction(() => {
      skillService().restore(id, body.base_revision_id, body.base_draft_hash);
      return { ok: true };
    });
  });
  app.put("/api/library/skills/:id/reviews/:revisionId", async (request) => {
    const { id, revisionId } = skillRevisionId.parse(request.params);
    return skillAction(() => {
      skillService().markReviewed(id, revisionId);
      return { ok: true };
    });
  });

  app.get("/api/rooms/:id/picker-locations", async (request) => {
    const { id } = idParams.parse(request.params);
    const project = service.roomState(id).room.project_path;
    return {
      skills: options.skillsHome ? resolve(options.skillsHome, "skills") : null,
      project: project ? join(project, ".konfab", "skills") : null,
      sources: sourceService()
        .list()
        .filter((source) => source.enabled === 1)
        .map((source) => `${source.owner}/${source.repository}`),
    };
  });

  app.get("/api/library/builtin", async () => {
    const library = skillService();
    return library.list("builtin");
  });

  const pinBody = z.union([
    z.object({
      skill_id: z.string().min(1).max(200),
      revision_id: z.string().uuid(),
      delivery: z.enum(["full", "summary"]).default("full"),
    }),
    z.object({
      public: z.object({
        source_id: z.string().uuid(),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        path: z.string().min(1).max(1024),
        preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
        scope: z.enum(["personal", "project"]).default("personal"),
        copy_name: z.string().min(1).max(128).optional(),
      }),
      delivery: z.enum(["full", "summary"]).default("full"),
    }),
  ]);
  const assignmentBody = z.object({
    base_revision: z.number().int().nonnegative(),
    instructions: z.string().max(6000).default(""),
    pins: z.array(pinBody).max(50),
    review: z.array(z.string().uuid()).max(50).default([]),
  });

  app.get("/api/rooms/:id/members/:agentId/assignment", async (request) => {
    const params = memberParams.parse(request.params);
    return service.memberAssignment(params.id, params.agentId);
  });
  app.post(
    "/api/rooms/:id/members/:agentId/assignment/size",
    async (request) => {
      memberParams.parse(request.params);
      const body = z
        .object({
          instructions: z.string().max(6000).default(""),
          pins: z
            .array(
              z.object({
                skill_id: z.string().min(1).max(200),
                revision_id: z.string().uuid(),
                delivery: z.enum(["full", "summary"]).default("full"),
              }),
            )
            .max(50),
        })
        .parse(request.body);
      return service.assignmentSize(body.instructions, body.pins);
    },
  );
  /**
   * Fetches and verifies the public skills in a selection before any
   * transaction (nothing is stored), and returns a function that, inside the
   * caller's transaction, copies them locally and returns the pins. Each
   * public skill's new revision is added to `review`: confirming the
   * assignment reviews it.
   */
  const preparePins = async (
    roomId: number,
    pins: z.infer<typeof pinBody>[],
  ) => {
    const packs = await Promise.all(
      pins.map((pin) =>
        "public" in pin
          ? sourceService().live.packageFiles(
              pin.public.source_id,
              pin.public.commit,
              pin.public.path,
              pin.public.preview_hash,
            )
          : null,
      ),
    );
    return (review: string[]) =>
      pins.map((pin, index) => {
        if (!("public" in pin)) return pin;
        const { libraryId } = skillScope(pin.public.scope, roomId, true);
        if (!libraryId)
          throw new SkillError("unavailable", 404, "Skill library unavailable");
        let imported;
        try {
          imported = skillService().importPublicForAssignment(
            libraryId,
            packs[index]!,
            { name: pin.public.copy_name },
          );
        } catch (error) {
          // Tell the page which selected skill needs a choice.
          if (error instanceof SkillError) Object.assign(error, { pin: index });
          throw error;
        }
        review.push(imported.revision_id);
        return {
          skill_id: imported.skill_id,
          revision_id: imported.revision_id,
          delivery: pin.delivery,
        };
      });
  };

  app.put("/api/rooms/:id/members/:agentId/assignment", async (request) => {
    const params = memberParams.parse(request.params);
    const body = assignmentBody.parse(request.body);
    const resolve = await preparePins(params.id, body.pins);
    service.setAssignment(
      params.id,
      params.agentId,
      {
        base_revision: body.base_revision,
        instructions: body.instructions,
        pins: [],
        review: body.review,
      },
      () => resolve(body.review),
    );
    if (body.pins.some((pin) => "public" in pin))
      skillService().finishWorkspaces();
    return service.memberAssignment(params.id, params.agentId);
  });

  app.get("/api/library/skills/:id/usages", async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return { usages: service.skillUsages(id) };
  });
  app.post("/api/library/skills/:id/update-assignments", async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        revision_id: z.string().uuid(),
        targets: z
          .array(
            z.object({
              room_id: z.number().int().positive(),
              agent_id: z.string().min(1),
              base_revision: z.number().int().nonnegative(),
            }),
          )
          .min(1)
          .max(200),
        review: z.literal(true, {
          message: "Review the new revision and confirm the update.",
        }),
      })
      .parse(request.body);
    service.updateSkillAssignments(id, body.revision_id, body.targets, true);
    return { ok: true };
  });

  app.post("/api/rooms/:id/assignments/reassign", async (request) => {
    const body = z
      .object({
        changes: z
          .array(
            z.object({
              agent_id: z.string().min(1),
              from_agent_id: z.string().min(1).optional(),
              pins: z
                .array(
                  z.object({
                    skill_id: z.string().min(1).max(200),
                    revision_id: z.string().uuid(),
                    delivery: z.enum(["full", "summary"]).default("full"),
                  }),
                )
                .max(50)
                .optional(),
              instructions: z.string().max(6000).optional(),
              none: z.literal(true).optional(),
              base_revision: z.number().int().nonnegative(),
            }),
          )
          .min(1)
          .max(100),
      })
      .parse(request.body);
    service.reassignAssignments(
      idParams.parse(request.params).id,
      body.changes,
    );
    return { ok: true };
  });

  app.post("/api/agents", async (request, reply) => {
    const body = z
      .object({
        id: z.string().min(1),
        display_name: z.string().min(1),
        app_id: z.string().min(1),
        room_id: z.number().int().positive().optional(),
        room_name: z.string().max(200).optional(),
        assignment: z
          .object({
            instructions: z.string().max(6000).default(""),
            pins: z.array(pinBody).max(50),
            review: z.array(z.string().uuid()).max(50).default([]),
            confirmed: z.literal(true, {
              message: "Preview the skills and confirm them before assigning.",
            }),
          })
          .optional(),
      })
      .parse(request.body);
    const assignment = body.assignment;
    const resolve =
      assignment && body.room_id
        ? await preparePins(body.room_id, assignment.pins)
        : null;
    service.addAppAgent(
      body.app_id,
      body.id,
      body.display_name,
      body.room_id,
      assignment
        ? () =>
            service.applyAssignment(body.room_id as number, body.id, {
              instructions: assignment.instructions,
              pins: resolve ? resolve(assignment.review) : [],
              review: assignment.review,
            })
        : undefined,
      body.room_name,
    );
    if (assignment?.pins.some((pin) => "public" in pin))
      skillService().finishWorkspaces();
    return reply.code(201).send({ ok: true });
  });
  app.patch("/api/agents/:agentId", async (request) => {
    const { agentId } = z
      .object({ agentId: z.string().min(1) })
      .parse(request.params);
    const body = z
      .object({ display_name: z.string().min(1) })
      .parse(request.body);
    service.renameAppAgent(agentId, body.display_name);
    return { ok: true };
  });
  app.delete("/api/agents/:agentId", async (request) => {
    const { agentId } = z
      .object({ agentId: z.string().min(1) })
      .parse(request.params);
    service.archiveAppAgent(agentId);
    return { ok: true };
  });

  app.post("/api/rooms/:id/formats", async (request, reply) => {
    const body = z
      .object({
        kind: z.enum(["review", "debate"]),
        topic: z.string().min(1).max(1000),
        rounds: z.number().int().min(1).max(5),
        author: z.string().optional(),
        reviewers: z.array(z.string()).max(3).optional(),
        pro: z.string().optional(),
        con: z.string().optional(),
        judge: z.string().optional(),
      })
      .parse(request.body);
    return reply
      .code(201)
      .send(service.startFormat(idParams.parse(request.params).id, body));
  });
  app.post("/api/rooms/:id/formats/control", async (request) => {
    const body = z
      .object({ action: z.enum(["pause", "resume", "skip", "end"]) })
      .parse(request.body);
    service.controlFormat(idParams.parse(request.params).id, body.action);
    return { ok: true };
  });

  app.post("/api/rooms/:id/locks/release", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({ resource: z.string().min(1).max(1000) })
      .parse(request.body);
    service.forceReleaseLock(id, body.resource);
    return { ok: true };
  });

  app.get("/api/overview", async () => ({
    ...service.overview(),
    instance_id: instanceId,
  }));

  app.post("/api/rooms", async (request, reply) => {
    const body = createRoomBody.parse(request.body);
    const room = service.createRoom(body.name, body.topic, body.members);
    return reply.code(201).send(room);
  });

  app.post("/api/rooms/:id/read", async (request) => {
    const body = z
      .object({
        ids: z.array(z.number().int().positive()).max(200).default([]),
        all: z.boolean().default(false),
      })
      .parse(request.body);
    return service.markLeadRead(
      idParams.parse(request.params).id,
      body.ids,
      body.all,
    );
  });

  app.get("/api/rooms/:id/messages", async (request) => {
    const query = z
      .object({ before: z.coerce.number().int().positive() })
      .parse(request.query);
    return service.leadMessagePage(
      idParams.parse(request.params).id,
      query.before,
    );
  });

  app.get("/api/rooms/:id", async (request) => {
    return service.roomState(idParams.parse(request.params).id);
  });

  app.get("/api/rooms/:id/permissions", async (request) => {
    const { id } = idParams.parse(request.params);
    const { before_id } = z
      .object({ before_id: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    return service.permissionHistory(id, before_id);
  });

  app.get("/api/rooms/:id/activity", async (request) => {
    const { id } = idParams.parse(request.params);
    const { before_id } = z
      .object({ before_id: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    return { events: service.activity(id, before_id) };
  });

  app.post("/api/rooms/:id/decisions", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        body: z.string().trim().min(1).max(2000),
        source_message_id: z.number().int().positive().optional(),
      })
      .parse(request.body);
    return reply
      .code(201)
      .send(
        service.createDecision(
          id,
          body.body,
          "user",
          body.source_message_id,
          undefined,
          true,
        ),
      );
  });

  app.get("/api/rooms/:id/decisions/:decisionId/versions", async (request) => {
    const { id, decisionId } = z
      .object({
        id: z.coerce.number().int().positive(),
        decisionId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    return { versions: service.decisionVersions(id, decisionId) };
  });

  app.post("/api/rooms/:id/decisions/:decisionId", async (request) => {
    const { id, decisionId } = z
      .object({
        id: z.coerce.number().int().positive(),
        decisionId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const body = z
      .object({
        action: z.enum(["confirm", "reject", "revise", "retire"]),
        body: z.string().trim().min(1).max(2000).optional(),
      })
      .parse(request.body);
    return service.updateDecision(id, decisionId, body.action, body.body);
  });

  app.put("/api/rooms/:id/auto-continue", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ enabled: z.boolean() }).parse(request.body);
    service.setAutoContinue(id, body.enabled);
    return service.roomState(id);
  });
  app.post(
    "/api/rooms/:id/auto-continue/:continuationId/cancel",
    async (request) => {
      const { id, continuationId } = z
        .object({
          id: z.coerce.number().int().positive(),
          continuationId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      service.cancelAutoContinue(id, continuationId);
      return service.roomState(id);
    },
  );

  app.patch("/api/rooms/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const {
      name,
      topic,
      brief,
      project_path,
      parallel_lead_mentions,
      checkin_minutes,
    } = updateRoomBody.parse(request.body);
    service.updateRoom(id, {
      ...(name !== undefined ? { name } : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(brief !== undefined ? { brief } : {}),
      ...(project_path !== undefined ? { project_path } : {}),
      ...(parallel_lead_mentions !== undefined
        ? { parallel_lead_mentions }
        : {}),
      ...(checkin_minutes !== undefined ? { checkin_minutes } : {}),
    });
    return service.roomState(id);
  });

  app.put("/api/rooms/:id/members/:agentId", async (request) => {
    const { id, agentId } = memberParams.parse(request.params);
    service.setMemberEdit(
      id,
      agentId,
      z.object({ can_edit: z.boolean() }).parse(request.body).can_edit,
    );
    return service.roomState(id);
  });

  app.put("/api/rooms/:id/members", async (request) => {
    const { id } = idParams.parse(request.params);
    service.setMembers(id, membersBody.parse(request.body).members);
    return service.roomState(id);
  });
  app.put("/api/rooms/:id/members/:agentId/name", async (request) => {
    const { id, agentId } = memberParams.parse(request.params);
    const { name } = z
      .object({ name: z.string().min(1).max(200) })
      .parse(request.body);
    service.setRoomName(id, agentId, name);
    return { ok: true };
  });
  app.delete("/api/rooms/:id/members/:agentId/name", async (request) => {
    const { id, agentId } = memberParams.parse(request.params);
    service.setRoomName(id, agentId, null);
    return { ok: true };
  });

  app.get("/api/rooms/:id/deletion-preview", async (request) => {
    const { id } = idParams.parse(request.params);
    return service.roomDeletionPreview(id);
  });
  app.post("/api/rooms/:id/delete", async (request) => {
    const { id } = idParams.parse(request.params);
    const { name } = z.object({ name: z.string() }).parse(request.body);
    return service.deleteRoom(id, name);
  });

  app.post("/api/rooms/:id/archive", async (request) => {
    const { id } = idParams.parse(request.params);
    service.archiveRoom(id);
    return { ok: true };
  });

  app.post("/api/rooms/:id/pause", async (request) => {
    const { id } = idParams.parse(request.params);
    service.setRoomPaused(id, pauseBody.parse(request.body).paused);
    return { ok: true };
  });

  app.post("/api/rooms/:id/messages", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = userMessageBody.parse(request.body);
    return service.postUserMessage(id, body.body, body.attachment_ids);
  });

  app.post(
    "/api/rooms/:id/attachments",
    { bodyLimit: service.maxAttachmentBytes },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { name } = z
        .object({ name: z.string().min(1).max(1000) })
        .parse(request.query);
      if (!Buffer.isBuffer(request.body))
        throw new KonfabError("invalid_attachment", 400, "Expected file data");
      return reply
        .code(201)
        .send(service.uploadAttachment(id, name, request.body));
    },
  );

  app.get(
    "/api/rooms/:id/attachments/:attachmentId",
    async (request, reply) => {
      const { id, attachmentId } = z
        .object({
          id: z.coerce.number().int().positive(),
          attachmentId: z.string().uuid(),
        })
        .parse(request.params);
      const { inline } = z
        .object({ inline: z.enum(["1"]).optional() })
        .parse(request.query);
      const attachment = service.getAttachment(id, attachmentId);
      const allowInline =
        inline === "1" &&
        ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          attachment.media_type,
        );
      const filename = encodeURIComponent(attachment.filename).replace(
        /['()*]/g,
        (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return reply
        .header("Content-Type", attachment.media_type)
        .header(
          "Content-Disposition",
          `${allowInline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
        )
        .header("X-Content-Type-Options", "nosniff")
        .send(attachment.data);
    },
  );

  app.delete("/api/rooms/:id/attachments/:attachmentId", async (request) => {
    const { id, attachmentId } = z
      .object({
        id: z.coerce.number().int().positive(),
        attachmentId: z.string().uuid(),
      })
      .parse(request.params);
    service.removeStagedAttachment(id, attachmentId);
    return { ok: true };
  });

  app.get("/api/rooms/:id/search", async (request) => {
    const { id } = idParams.parse(request.params);
    return {
      messages: service.searchMessages(id, searchQuery.parse(request.query).q),
    };
  });

  app.get("/api/rooms/:id/export", async (request, reply) => {
    const { filename, markdown } = service.exportRoom(
      idParams.parse(request.params).id,
    );
    return reply
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(markdown);
  });

  app.post("/api/rooms/:id/members/:agentId/extend-run", async (request) => {
    const { id, agentId } = memberParams.parse(request.params);
    service.extendRunWindow(
      id,
      agentId,
      extendBody.parse(request.body).minutes,
    );
    return { ok: true };
  });

  app.post("/api/rooms/:id/break", async (request) => {
    service.takeBreak(idParams.parse(request.params).id);
    return { ok: true };
  });

  app.post("/api/break-all", async () => {
    service.takeBreakAll();
    return { ok: true };
  });

  app.post("/api/pause-all", async (request) => {
    service.setAllPaused(pauseBody.parse(request.body).paused);
    return { ok: true };
  });

  app.post("/api/permissions/:id/decision", async (request) => {
    const { id } = idParams.parse(request.params);
    return service.decidePermission(
      id,
      decisionBody.parse(request.body).decision,
    );
  });

  app.post("/api/reports/:id/dismiss", async (request) => {
    service.dismissReport(idParams.parse(request.params).id);
    return { ok: true };
  });

  // The lead asks a Codex agent to rejoin. Agents have no route to this.
  const askToRejoin = async (
    roomId: number,
    agentId: string,
    again: boolean,
  ): Promise<SendResult> => {
    if (!options.sendRejoin && !options.watchers)
      throw new KonfabError(
        "rejoin_unavailable",
        409,
        "This agent can't be asked to rejoin now; use its rejoin prompt",
      );
    const asked = service.rejoin.ask(roomId, agentId, again);
    let result: SendResult = "unsure";
    try {
      // The other route's means are never used instead.
      result =
        asked.route === "watch"
          ? ((await options.watchers?.send(asked)) ?? "refused")
          : ((await options.sendRejoin?.(asked.conversation, asked.number)) ??
            "refused");
    } finally {
      service.rejoin.sent(asked.id, result);
    }
    return result;
  };
  const rejoinParams = z.object({
    id: z.coerce.number().int().positive(),
    agent: z.string().min(1).max(100),
  });
  // For several, or with the room first. Each is asked by its own rules, and
  // what was done to the room stays if an agent then can't be asked.
  const rejoinRoom = z
    .object({
      open: z.array(z.enum(["pause", "break"])).default([]),
      agents: z
        .array(
          z
            .object({
              id: z.string().min(1).max(100),
              again: z.boolean().default(false),
            })
            .strict(),
        )
        .max(100),
    })
    .strict();
  app.post("/api/rooms/:id/rejoin", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = rejoinRoom.parse(request.body);
    const opened = service.openRoom(id, body.open);
    const results = await Promise.all(
      body.agents.map(async (agent) => {
        try {
          return (await askToRejoin(id, agent.id, agent.again)) === "refused"
            ? {
                agent_id: agent.id,
                ok: false,
                error: "Its app didn't take it; nothing is waiting there",
              }
            : { agent_id: agent.id, ok: true };
        } catch (error) {
          if (!(error instanceof KonfabError)) app.log.error(error);
          return {
            agent_id: agent.id,
            ok: false,
            error:
              error instanceof KonfabError
                ? error.message
                : "Something went wrong; look at the log",
          };
        }
      }),
    );
    return { opened, results };
  });
  // Brings the agent's app to the front. It sends nothing to the agent.
  app.post("/api/rooms/:id/agents/:agent/open", async (request) => {
    const { id, agent } = rejoinParams.parse(request.params);
    const { app: name, can_open } = service.rejoin.beforePaste(id, agent);
    const opened =
      can_open && options.openApp ? await options.openApp(name) : false;
    return { opened, here: service.rejoin.beforePaste(id, agent).here };
  });
  const stopAgents = z
    .object({ agents: z.array(z.string().min(1).max(100)).max(100) })
    .strict();
  app.post("/api/rooms/:id/stop-agents", async (request) => {
    const { id } = idParams.parse(request.params);
    service.requireRoom(id);
    const { agents } = stopAgents.parse(request.body);
    return { results: service.stops.askAll(id, agents) };
  });
  app.post("/api/rooms/:id/keep-agents", async (request) => {
    const { id } = idParams.parse(request.params);
    service.requireRoom(id);
    const { agents } = stopAgents.parse(request.body);
    return { kept: service.stops.keepAll(id, agents) };
  });
  const again = z.object({ again: z.boolean().default(false) }).strict();
  app.post("/api/rooms/:id/agents/:agent/rejoin", async (request) => {
    const { id, agent } = rejoinParams.parse(request.params);
    const body = again.parse(request.body ?? {});
    await askToRejoin(id, agent, body.again);
    return { ok: true };
  });
  app.delete("/api/rooms/:id/agents/:agent/rejoin", async (request) => {
    const { id, agent } = rejoinParams.parse(request.params);
    service.rejoin.cancel(id, agent);
    return { ok: true };
  });

  // The lead stops one agent in a room, or keeps it. Agents have no route.
  app.post("/api/rooms/:id/agents/:agent/stop", async (request) => {
    const { id, agent } = rejoinParams.parse(request.params);
    service.stops.ask(id, agent);
    return { ok: true };
  });
  app.delete("/api/rooms/:id/agents/:agent/stop", async (request) => {
    const { id, agent } = rejoinParams.parse(request.params);
    service.stops.keep(id, agent);
    return { ok: true };
  });

  // The lead's phone notices. Agents have no route to these.
  app.post("/api/activity", async () => {
    options.notices?.active();
    return { ok: true };
  });
  const noPhoneNotices: NoticesView = {
    state: "not_set_up",
    chat_name: null,
    away_minutes: 10,
    problem: null,
  };
  app.get(
    "/api/phone-notices",
    async () => options.notices?.view() ?? noPhoneNotices,
  );
  app.put("/api/phone-notices", async (request) => {
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(request.body);
    options.notices?.active();
    return options.notices?.setEnabled(enabled) ?? noPhoneNotices;
  });

  app.get("/api/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    const unsubscribe = service.subscribe(() =>
      reply.raw.write("data: change\n\n"),
    );
    const keepAlive = setInterval(
      () => reply.raw.write(": keep-alive\n\n"),
      25_000,
    );
    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  if (webDir) {
    await app.register(fastifyStatic, { root: webDir });
  }

  return app;
}
