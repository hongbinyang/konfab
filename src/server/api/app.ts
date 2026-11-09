import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Writable } from "node:stream";
import { z, ZodError } from "zod";
import { KonfabError, type KonfabService } from "../domain/service.js";

const MAX_SERVER_WAIT_SECONDS = 30;
const SESSION_COOKIE = "konfab_session";
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const session = { session_id: z.string().min(1) };
const turn = { ...session, turn_id: z.number().int().positive() };
const timeout = z.number().min(0).max(MAX_SERVER_WAIT_SECONDS).default(20);

const joinBody = z.object({ room: z.string().min(1) });
const waitBody = z.object({
  ...session,
  first: z.boolean().default(false),
  call_id: z.string().uuid().optional(),
  timeout_seconds: timeout,
});
const postBody = z.object({ ...turn, body: z.string() });
const passBody = z.object({ ...turn, reason: z.string().optional() });
const historyBody = z.object({
  ...session,
  before_id: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
const reportBody = z.object({
  ...session,
  kind: z.enum(["low_allowance", "out_of_allowance", "other", "working"]),
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
});
const memberParams = z.object({
  id: z.coerce.number().int().positive(),
  agentId: z.string().min(1),
});
const roleBody = z.object({ role: z.string(), can_edit: z.boolean() });
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
    forceCloseConnections: true,
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

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof KonfabError) {
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
      return reply
        .code(400)
        .send({ code: "invalid_request", message: "Invalid request" });
    }
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

  const requireAgent = (request: FastifyRequest): string => {
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    const agentId = match?.[1] ? service.authenticateAgent(match[1]) : null;
    if (!agentId) {
      throw new KonfabError("unauthorized", 401, "Invalid agent token");
    }
    return agentId;
  };

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/agent/")) return;
    const agentId = requireAgent(request);
    const protocol = request.headers["x-konfab-protocol"] === "1" ? 1 : 0;
    service.recordBridgeProtocol(agentId, protocol);
  });

  app.get("/agent/protocol", async (request) => {
    requireAgent(request);
    return { durable_receipts: 1 };
  });

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

  app.post("/agent/join", async (request) => {
    const agentId = requireAgent(request);
    return repeatMutation(request, agentId, () =>
      service.join(agentId, joinBody.parse(request.body).room),
    );
  });

  app.post("/agent/wait", async (request) => {
    const agentId = requireAgent(request);
    const body = waitBody.parse(request.body);
    if (body.call_id)
      service.beginObservedWait(agentId, body.session_id, body.call_id);
    return service.waitForTurn(
      agentId,
      body.session_id,
      body.first,
      body.timeout_seconds * 1000,
    );
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

  app.get("/api/overview", async () => service.overview());

  app.post("/api/rooms", async (request, reply) => {
    const body = createRoomBody.parse(request.body);
    const room = service.createRoom(body.name, body.topic, body.members);
    return reply.code(201).send(room);
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

  app.patch("/api/rooms/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const { name, topic, brief } = updateRoomBody.parse(request.body);
    service.updateRoom(id, {
      ...(name !== undefined ? { name } : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(brief !== undefined ? { brief } : {}),
    });
    return service.roomState(id);
  });

  app.put("/api/rooms/:id/members/:agentId", async (request) => {
    const { id, agentId } = memberParams.parse(request.params);
    service.setMemberRole(id, agentId, roleBody.parse(request.body));
    return service.roomState(id);
  });

  app.put("/api/rooms/:id/members", async (request) => {
    const { id } = idParams.parse(request.params);
    service.setMembers(id, membersBody.parse(request.body).members);
    return service.roomState(id);
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
