import { BRIDGE_PROTOCOL_VERSION } from "../../protocol.js";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Writable } from "node:stream";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z, ZodError } from "zod";
import { parseDocument } from "yaml";
import { SkillError } from "../domain/skill-error.js";
import { skillMetadata } from "../domain/skill-files.js";
import type { SkillLibrary } from "../domain/skills.js";
import type { SkillSources } from "../domain/skill-sources.js";
import type { RoleLibrary } from "../domain/roles.js";
import { KonfabError, type KonfabService } from "../domain/service.js";

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
  project_path: z.string().nullable().optional(),
});
const memberParams = z.object({
  id: z.coerce.number().int().positive(),
  agentId: z.string().min(1),
});
const roleBody = z.object({
  role: z.string(),
  can_edit: z.boolean(),
  base_role_revision: z.number().int().nonnegative().optional(),
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
  skills?: SkillLibrary;
  sources?: SkillSources;
  roles?: RoleLibrary;
  skillsHome?: string;
  rolePicker?: boolean;
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

  app.setErrorHandler((error, request, reply) => {
    const libraryRequest =
      /^\/api\/(?:library(?:\/|\?|$)|roles(?:\/|\?|$)|rooms\/[^/]+\/members(?:\/|\?|$))/.test(
        request.url,
      );
    if (error instanceof SkillError) {
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message });
    }
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
    if (path === "/agent/join" || path === "/agent/protocol")
      return service.appAgent(appId);
    const body = request.body as { session_id?: unknown } | null;
    if (typeof body?.session_id !== "string" || !body.session_id)
      throw new KonfabError("session_required", 400, "session_id required");
    return service.sessionAgent(appId, body.session_id);
  };

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/agent/")) return;
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
    const appId = requireApp(request);
    const body = joinBody.parse(request.body);
    const agentId = service.appAgent(appId, body.as);
    return repeatMutation(request, agentId, () =>
      service.join(agentId, body.room),
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
    return { role: service.readAssignedRole(agentId, body.session_id) };
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
  }));
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
  app.post("/api/library/sources/:sourceId/refresh", async (request) => {
    const { sourceId: id } = sourceId.parse(request.params);
    sourceService().startRefresh(id);
    return { ok: true };
  });
  app.post("/api/library/sources/:sourceId/cancel", async (request) => {
    const { sourceId: id } = sourceId.parse(request.params);
    sourceService().cancel(id);
    return { ok: true };
  });
  app.get("/api/library/sources/:sourceId/skills", async (request) => {
    const { sourceId: id } = sourceId.parse(request.params);
    const { q } = z
      .object({ q: z.string().max(200).default("") })
      .parse(request.query);
    return sourceService().browse(id, q);
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
  app.get("/api/library/public", async (request) => {
    const { q } = z
      .object({ q: z.string().max(200).default("") })
      .parse(request.query);
    return sourceService().browseAll(q);
  });
  app.get("/api/library/sources/:sourceId/preview", async (request) => {
    const { sourceId: id } = sourceId.parse(request.params);
    const query = z
      .object({
        generation: z.string().uuid(),
        path: z.string().min(1).max(1024),
      })
      .parse(request.query);
    return sourceService().preview(id, query.generation, query.path);
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
  const renameImportedManifest = (
    files: Array<{ path: string; content: Buffer; mode: number }>,
    name: string,
  ) =>
    files.map((file) => {
      if (file.path !== "SKILL.md") return file;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        file.content,
      );
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (!match?.[1]) return file;
      const document = parseDocument(match[1], {
        uniqueKeys: true,
        customTags: [],
      });
      if (document.errors.length) return file;
      document.set("name", name);
      return {
        ...file,
        content: Buffer.from(
          `---\n${document.toString()}---\n${text.slice(match[0].length)}`,
        ),
      };
    });
  app.post("/api/library/sources/:sourceId/import", async (request) => {
    const { sourceId: id } = sourceId.parse(request.params);
    const body = z
      .object({
        generation: z.string().uuid(),
        path: z.string().min(1).max(1024),
        scope: z.enum(["personal", "project"]),
        room_id: z.number().int().positive().optional(),
        name: z.string().min(1).max(128),
        mode: z.enum(["add", "duplicate_fix"]).default("add"),
      })
      .parse(request.body);
    const { library, libraryId } = skillScope(body.scope, body.room_id, true);
    if (!libraryId)
      throw new SkillError("unavailable", 404, "Library unavailable");
    const selected = await sourceService().packageFiles(
      id,
      body.generation,
      body.path,
    );
    const files = renameImportedManifest(selected.files, body.name);
    if (selected.diagnostic && body.mode === "add")
      throw new SkillError(
        "invalid_skill",
        400,
        "Invalid source package; use Duplicate & fix",
      );
    if (selected.diagnostic || body.mode === "duplicate_fix") {
      return {
        draft_id: library.createImportDraft(
          libraryId,
          body.name,
          files,
          selected.provenance,
          selected.licence,
          selected.diagnostic ?? "Review and save this imported draft",
        ),
      };
    }
    return {
      id: library.importFiles(
        libraryId,
        body.name,
        files,
        selected.provenance,
        selected.licence,
      ),
    };
  });
  const draftId = z.object({ draftId: z.string().uuid() });
  app.get("/api/library/import-drafts/:draftId", async (request) => {
    const { draftId: id } = draftId.parse(request.params);
    return skillService().importDraft(id);
  });
  app.put("/api/library/import-drafts/:draftId", async (request) => {
    const { draftId: id } = draftId.parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(128),
        manifest: z
          .string()
          .refine((value) => Buffer.byteLength(value) <= 512 * 1024),
        base_revision: z.number().int().nonnegative(),
      })
      .parse(request.body);
    return {
      revision: skillService().updateImportDraft(
        id,
        body.name,
        body.manifest,
        body.base_revision,
      ),
    };
  });
  app.post("/api/library/import-drafts/:draftId/save", async (request) => {
    const { draftId: id } = draftId.parse(request.params);
    const { base_revision } = z
      .object({ base_revision: z.number().int().nonnegative() })
      .parse(request.body);
    return { id: skillService().promoteImportDraft(id, base_revision) };
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

  const roleService = () => {
    if (!options.roles)
      throw new KonfabError("unavailable", 503, "Roles unavailable");
    return options.roles;
  };
  app.get("/api/roles", async (request) => {
    const { trash } = z
      .object({ trash: z.enum(["true", "false"]).default("false") })
      .parse(request.query);
    return { roles: roleService().list(trash === "true") };
  });
  app.get("/api/roles/custom-assignments", async () => ({
    assignments: roleService().customAssignments(),
  }));
  app.post("/api/roles/convert-custom", async (request) => {
    const body = z
      .object({
        groups: z
          .array(
            z.object({
              name: z.string().min(1).max(128),
              title: z.string().min(1).max(100),
              description: z.string().min(1).max(1024),
              text: z.string().min(1).max(20000),
              assign: z.boolean(),
              members: z
                .array(
                  z.object({
                    room_id: z.number().int().positive(),
                    agent_id: z.string().min(1),
                    revision: z.number().int().nonnegative(),
                  }),
                )
                .min(1)
                .max(100),
            }),
          )
          .min(1)
          .max(100),
      })
      .parse(request.body);
    const result = roleService().convertCustom(body.groups);
    for (const group of body.groups)
      if (group.assign)
        for (const member of group.members)
          service.rolesChanged(member.room_id, member.agent_id);
    return result;
  });
  app.post(
    "/api/rooms/:id/members/:agentId/revert-conversion",
    async (request) => {
      const params = memberParams.parse(request.params);
      const { base_revision } = z
        .object({ base_revision: z.number().int().nonnegative() })
        .parse(request.body);
      roleService().revertConversion(params.id, params.agentId, base_revision);
      service.rolesChanged(params.id, params.agentId);
      return { ok: true };
    },
  );
  app.post("/api/roles", async (request) => {
    const body = z
      .object({
        name: z.string().min(1).max(128),
        title: z.string().min(1).max(100),
        description: z.string().min(1).max(1024),
      })
      .parse(request.body);
    const content = Buffer.from(
      `---\nname: ${JSON.stringify(body.name)}\ntitle: ${JSON.stringify(body.title)}\ndescription: ${JSON.stringify(body.description)}\nskills: []\n---\n\n# ${body.title}\n`,
    );
    return {
      id: roleService().createPersonal(
        "personal",
        body.name,
        [{ path: "ROLE.md", content, mode: 0o600 }],
        [],
      ),
    };
  });
  app.get("/api/roles/:id", async (request) => {
    const { id } = z
      .object({ id: z.string().min(1).max(200) })
      .parse(request.params);
    return roleService().detail(id);
  });
  app.post("/api/roles/:id/duplicate", async (request) => {
    const { id } = z
      .object({ id: z.string().min(1).max(200) })
      .parse(request.params);
    const { name } = z
      .object({ name: z.string().min(1).max(128) })
      .parse(request.body);
    return { id: roleService().duplicate(id, name) };
  });
  app.get("/api/roles/:id/revisions", async (request) => {
    const { id } = z
      .object({ id: z.string().min(1).max(200) })
      .parse(request.params);
    return roleService().revisions(id);
  });
  app.post("/api/roles/:id/revisions/:revisionId/restore", async (request) => {
    const { id, revisionId } = z
      .object({ id: z.string().min(1).max(200), revisionId: z.string().uuid() })
      .parse(request.params);
    const { base_revision } = z
      .object({ base_revision: z.string().uuid() })
      .parse(request.body);
    return {
      revision_id: roleService().restoreRevision(id, revisionId, base_revision),
    };
  });
  app.post("/api/roles/:id/trash", async (request) => {
    const { id } = z
      .object({ id: z.string().min(1).max(200) })
      .parse(request.params);
    const { base_revision } = z
      .object({ base_revision: z.string().uuid() })
      .parse(request.body);
    roleService().trash(id, base_revision);
    return { ok: true };
  });
  app.post("/api/roles/:id/restore", async (request) => {
    const { id } = z
      .object({ id: z.string().min(1).max(200) })
      .parse(request.params);
    const { base_revision } = z
      .object({ base_revision: z.string().uuid() })
      .parse(request.body);
    roleService().restore(id, base_revision);
    return { ok: true };
  });
  app.post("/api/roles/:id/save", async (request) => {
    const { id } = z
      .object({ id: z.string().min(1).max(200) })
      .parse(request.params);
    const body = z
      .object({
        base_revision: z.string().uuid(),
        manifest: z
          .string()
          .refine((value) => Buffer.byteLength(value) <= 512 * 1024),
        pins: z
          .array(
            z.object({
              skill_id: z.string().uuid(),
              revision_id: z.string().uuid(),
            }),
          )
          .max(100),
      })
      .parse(request.body);
    return {
      revision_id: roleService().saveManifest(
        id,
        body.base_revision,
        body.manifest,
        body.pins,
      ),
    };
  });
  app.get("/api/roles/:id/draft", async (request) => {
    const { id } = z
      .object({ id: z.string().min(1).max(200) })
      .parse(request.params);
    return roleService().workingDraft(id);
  });
  app.post("/api/roles/:id/draft/save", async (request) => {
    const { id } = z
      .object({ id: z.string().min(1).max(200) })
      .parse(request.params);
    const body = z
      .object({
        base_revision: z.string().uuid(),
        draft_hash: z.string().regex(/^[a-f0-9]{64}$/),
        pins: z
          .array(
            z.object({
              skill_id: z.string().uuid(),
              revision_id: z.string().uuid(),
            }),
          )
          .max(100),
      })
      .parse(request.body);
    return {
      revision_id: roleService().saveWorkingDraft(
        id,
        body.base_revision,
        body.draft_hash,
        body.pins,
      ),
    };
  });
  app.put("/api/rooms/:id/members/:agentId/role-pack", async (request) => {
    const params = memberParams.parse(request.params);
    const body = z
      .object({
        role_id: z.string().min(1).max(200),
        role_revision_id: z.string().uuid(),
        notes: z.string().max(4000).default(""),
        base_revision: z.number().int().nonnegative().optional(),
        can_edit: z.boolean().optional(),
      })
      .parse(request.body);
    roleService().assign(
      params.id,
      params.agentId,
      body.role_id,
      body.role_revision_id,
      body.notes,
      body.base_revision,
      body.can_edit,
    );
    service.rolesChanged(params.id, params.agentId);
    return { ok: true };
  });
  app.post(
    "/api/rooms/:id/members/:agentId/picker-preflight",
    async (request) => {
      const params = memberParams.parse(request.params);
      const body = z
        .object({
          scope: z.enum(["personal", "project"]),
          role_name: z.string().min(1).max(128),
          skill_name: z.string().min(1).max(128),
        })
        .parse(request.body);
      roleService().checkPersonalName(body.role_name);
      const { library, libraryId } = skillScope(body.scope, params.id);
      if (!libraryId)
        throw new SkillError(
          "unavailable",
          404,
          "Skill library unavailable; create it first.",
        );
      const list = library.list(libraryId);
      if (
        list.untracked.includes(body.skill_name) ||
        list.skills.some(
          (skill) =>
            (skill as Record<string, unknown>).folder_name === body.skill_name,
        )
      )
        throw new SkillError("name_conflict", 409, "Skill name already exists");
      return { ok: true };
    },
  );
  app.post(
    "/api/rooms/:id/members/:agentId/role-from-public",
    async (request) => {
      const params = memberParams.parse(request.params);
      const body = z
        .object({
          source_id: z.string().uuid(),
          scope: z.enum(["personal", "project"]).default("personal"),
          custom_manifest: z.string().max(512000).optional(),
          copy_name: z.string().min(1).max(128).optional(),
          commit: z.string().regex(/^[a-f0-9]{40}$/),
          path: z.string().min(1).max(1024),
          preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
          role_name: z.string().min(1).max(128),
          title: z.string().min(1).max(100),
          description: z.string().min(1).max(1024),
          instructions: z.string().max(20000).optional(),
          notes: z.string().max(4000).default(""),
          base_revision: z.number().int().nonnegative().optional(),
        })
        .parse(request.body);
      roleService().checkPersonalName(body.role_name);
      const { library, libraryId } = skillScope(body.scope, params.id, true);
      if (!libraryId)
        throw new SkillError(
          "unavailable",
          404,
          "Personal skill library unavailable",
        );
      const pack = await sourceService().live.packageFiles(
        body.source_id,
        body.commit,
        body.path,
        body.preview_hash,
      );
      if (body.custom_manifest !== undefined) {
        if (!body.copy_name)
          throw new SkillError(
            "invalid_skill",
            400,
            "Enter a name for the skill copy.",
          );
        const manifest = pack.files.find((file) => file.path === "SKILL.md");
        if (!manifest)
          throw new SkillError("invalid_skill", 400, "SKILL.md is required");
        manifest.content = Buffer.from(body.custom_manifest);
      }
      const metadata = skillMetadata(pack.files);
      if (
        body.custom_manifest !== undefined &&
        metadata.name !== body.copy_name
      )
        throw new SkillError(
          "invalid_skill",
          400,
          "SKILL.md name must match the skill copy name.",
        );
      const assigned = library.createReviewedForAssignment(
        libraryId,
        pack.files,
        { ...pack.provenance, customized: body.custom_manifest !== undefined },
        pack.licence,
        (skillId, skillRevision) =>
          roleService().createAndAssignSkill({
            roomId: params.id,
            agentId: params.agentId,
            libraryId,
            skillId,
            skillRevision,
            name: body.role_name,
            title: body.title,
            description: body.description,
            instructions:
              body.instructions ?? `Follow the ${metadata.name} skill.`,
            notes: body.notes,
            baseRevision: body.base_revision,
            deferMaterialize: true,
          }),
      );
      roleService().finishPendingWorkspaces();
      service.rolesChanged(params.id, params.agentId);
      return {
        ...assigned.value,
        pending:
          assigned.pending || roleService().workspacePending(assigned.value.id),
      };
    },
  );
  app.post(
    "/api/rooms/:id/members/:agentId/customize-and-assign",
    async (request) => {
      const params = memberParams.parse(request.params);
      const body = z
        .object({
          source_scope: z.enum(["personal", "project"]),
          scope: z.enum(["personal", "project"]),
          skill_id: z.string().uuid(),
          skill_revision: z.string().uuid(),
          copy_name: z.string().min(1).max(128),
          manifest: z.string().max(512000),
          role_name: z.string().min(1).max(128),
          title: z.string().min(1).max(100),
          description: z.string().min(1).max(1024),
          instructions: z.string().max(20000),
          notes: z.string().max(4000).default(""),
          base_revision: z.number().int().nonnegative().optional(),
        })
        .parse(request.body);
      roleService().checkPersonalName(body.role_name);
      const source = skillScope(body.source_scope, params.id);
      if (!source.libraryId)
        throw new SkillError(
          "unavailable",
          404,
          "Source skill library unavailable",
        );
      const target = skillScope(body.scope, params.id, true);
      if (!target.libraryId)
        throw new SkillError(
          "unavailable",
          404,
          "Destination skill library unavailable",
        );
      const pack = source.library.copyCurrentRevision(
        body.skill_id,
        body.skill_revision,
        source.libraryId,
      );
      const manifest = pack.files.find((file) => file.path === "SKILL.md");
      if (!manifest)
        throw new SkillError("invalid_skill", 400, "SKILL.md is required");
      manifest.content = Buffer.from(body.manifest);
      if (skillMetadata(pack.files).name !== body.copy_name)
        throw new SkillError(
          "invalid_skill",
          400,
          "SKILL.md name must match the skill copy name.",
        );
      const assigned = target.library.createReviewedForAssignment(
        target.libraryId,
        pack.files,
        pack.provenance,
        pack.licence,
        (skillId, skillRevision) => {
          source.library.copyCurrentRevision(
            body.skill_id,
            body.skill_revision,
            source.libraryId!,
          );
          return roleService().createAndAssignSkill({
            roomId: params.id,
            agentId: params.agentId,
            libraryId: target.libraryId!,
            skillId,
            skillRevision,
            name: body.role_name,
            title: body.title,
            description: body.description,
            instructions: body.instructions,
            notes: body.notes,
            baseRevision: body.base_revision,
            deferMaterialize: true,
          });
        },
      );
      roleService().finishPendingWorkspaces();
      service.rolesChanged(params.id, params.agentId);
      return {
        ...assigned.value,
        pending:
          assigned.pending || roleService().workspacePending(assigned.value.id),
      };
    },
  );
  app.post(
    "/api/rooms/:id/members/:agentId/role-from-skill",
    async (request) => {
      const params = memberParams.parse(request.params);
      const body = z
        .object({
          scope: z.enum(["personal", "project"]),
          skill_id: z.string().uuid(),
          skill_revision: z.string().uuid(),
          name: z.string().min(1).max(128),
          title: z.string().min(1).max(100),
          description: z.string().min(1).max(1024),
          instructions: z.string().max(20000),
          notes: z.string().max(4000).default(""),
          base_revision: z.number().int().nonnegative().optional(),
          review: z.boolean().default(false),
        })
        .parse(request.body);
      const { libraryId } = skillScope(body.scope, params.id);
      if (!libraryId)
        throw new SkillError("unavailable", 404, "Skill library unavailable");
      const result = roleService().createAndAssignSkill({
        roomId: params.id,
        agentId: params.agentId,
        libraryId,
        skillId: body.skill_id,
        skillRevision: body.skill_revision,
        name: body.name,
        title: body.title,
        description: body.description,
        instructions: body.instructions,
        notes: body.notes,
        baseRevision: body.base_revision,
        review: body.review,
      });
      service.rolesChanged(params.id, params.agentId);
      return result;
    },
  );
  app.get("/api/rooms/:id/members/:agentId/role-updates", async (request) => {
    const params = memberParams.parse(request.params);
    const items = roleService().assignedPublicSources(
      params.id,
      params.agentId,
    );
    const updates = await Promise.all(
      items.map(async (item) => {
        try {
          const status = await sourceService().publicSkillUpdate(
            item.source,
            item.commit,
            item.path,
          );
          return { ...item, status };
        } catch {
          return { ...item, status: "unknown" };
        }
      }),
    );
    return { updates };
  });
  app.get("/api/rooms/:id/members/:agentId/role-preview", async (request) => {
    const params = memberParams.parse(request.params);
    return {
      role: roleService().envelope(params.id, params.agentId, false, true),
      assignment: roleService().assignment(params.id, params.agentId),
    };
  });

  app.post("/api/rooms/:id/roles/reassign", async (request) => {
    const body = z
      .object({
        changes: z
          .array(
            z.object({
              agent_id: z.string().min(1),
              from_agent_id: z.string().min(1).optional(),
              role_id: z.string().min(1).optional(),
              role_revision_id: z.string().min(1).optional(),
              notes: z.string().max(4000).optional(),
              none: z.literal(true).optional(),
              base_revision: z.number().int().nonnegative(),
            }),
          )
          .min(1)
          .max(100),
      })
      .parse(request.body);
    service.reassignRoles(idParams.parse(request.params).id, body.changes);
    return { ok: true };
  });

  app.post("/api/apps/:appId/agents", async (request, reply) => {
    const { appId } = z
      .object({ appId: z.string().min(1) })
      .parse(request.params);
    const body = z
      .object({
        id: z.string().min(1),
        display_name: z.string().min(1),
        room_id: z.number().int().positive().optional(),
      })
      .parse(request.body);
    service.addAppAgent(appId, body.id, body.display_name, body.room_id);
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
    ui: { role_picker: options.rolePicker ?? true },
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
    const { name, topic, brief, project_path } = updateRoomBody.parse(
      request.body,
    );
    service.updateRoom(id, {
      ...(name !== undefined ? { name } : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(brief !== undefined ? { brief } : {}),
      ...(project_path !== undefined ? { project_path } : {}),
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
