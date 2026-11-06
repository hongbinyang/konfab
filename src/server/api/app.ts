import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { KonfabError, type KonfabService } from "../domain/service.js";

const MAX_SERVER_WAIT_SECONDS = 30;

const joinBody = z.object({ room: z.string().min(1) });
const waitBody = z.object({
  session_id: z.string().min(1),
  first: z.boolean().default(false),
  timeout_seconds: z.number().min(0).max(MAX_SERVER_WAIT_SECONDS).default(20),
});
const postBody = z.object({
  session_id: z.string().min(1),
  turn_id: z.number().int().positive(),
  body: z.string(),
});
const passBody = z.object({
  session_id: z.string().min(1),
  turn_id: z.number().int().positive(),
  reason: z.string().optional(),
});
const userMessageBody = z.object({ body: z.string() });

export interface AppOptions {
  service: KonfabService;
  roomName: string;
  port: number;
  publicDir?: string;
  logger?: boolean;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { service, roomName, port, publicDir } = options;
  const app = Fastify({
    logger: options.logger
      ? { redact: ["req.headers.authorization", "req.headers.cookie"] }
      : false,
    forceCloseConnections: true,
  });

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
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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

  const requireAgent = (request: FastifyRequest): string => {
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    const agentId = match?.[1] ? service.authenticateAgent(match[1]) : null;
    if (!agentId)
      throw new KonfabError("unauthorized", 401, "Invalid agent token");
    return agentId;
  };

  app.post("/agent/join", async (request) => {
    const agentId = requireAgent(request);
    return service.join(agentId, joinBody.parse(request.body).room);
  });

  app.post("/agent/wait", async (request) => {
    const agentId = requireAgent(request);
    const body = waitBody.parse(request.body);
    return service.waitForTurn(
      agentId,
      body.session_id,
      body.first,
      body.timeout_seconds * 1000,
    );
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

  app.get("/api/state", async () => service.roomState(roomName));

  app.post("/api/messages", async (request) => {
    return service.postUserMessage(
      roomName,
      userMessageBody.parse(request.body).body,
    );
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

  if (publicDir) {
    await app.register(fastifyStatic, { root: publicDir });
  }

  return app;
}
