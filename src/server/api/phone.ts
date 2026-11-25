import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { KonfabError } from "../domain/errors.js";
import type { NoticesView, TelegramNotices } from "../telegram/notices.js";
import type { PhoneSetup } from "../telegram/setup.js";

const NONE: NoticesView = {
  state: "not_set_up",
  chat_name: null,
  away_minutes: 10,
  problem: null,
};
const SMALL = 1024;
const id = z.string().uuid();

/**
 * The lead's phone notices. Agents have no route to these. No request and no
 * answer has a token, and bodies are never quoted.
 */
export function phoneRoutes(
  app: FastifyInstance,
  deps: {
    notices: TelegramNotices | undefined;
    setup: PhoneSetup | undefined;
    origins: Set<string>;
  },
): void {
  const { notices } = deps;
  const setup = () => {
    if (!deps.setup)
      throw new KonfabError("not_available", 409, "Not available here");
    return deps.setup;
  };
  const view = () => ({
    ...(notices?.view() ?? NONE),
    ...(deps.setup
      ? {
          setup: deps.setup.view(),
          ways: deps.setup.ways(),
          left_over: deps.setup.leftOvers(),
        }
      : {}),
  });
  /** A change comes from this page itself, and from no other program's call. */
  const fromPage = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!deps.origins.has(request.headers.origin ?? ""))
      return reply
        .code(403)
        .send({ code: "forbidden", message: "Request not allowed" });
    notices?.active();
  };
  const post = (
    path: string,
    action: (body: unknown) => Promise<unknown> | unknown,
  ) =>
    app.post(
      `/api/phone-notices/${path}`,
      { onRequest: fromPage, bodyLimit: SMALL },
      async (request) => {
        await action(request.body ?? {});
        return view();
      },
    );

  app.get("/api/phone-notices", async () => view());
  app.put(
    "/api/phone-notices",
    { onRequest: fromPage, bodyLimit: SMALL },
    async (request) => {
      const { enabled } = z
        .object({ enabled: z.boolean() })
        .strict()
        .parse(request.body);
      notices?.active();
      await notices?.setEnabled(enabled);
      return view();
    },
  );

  const named = z.object({ id }).strict();
  post("setup", (body) =>
    setup().start(
      z
        .object({ way: z.enum(["terminal", "env"]) })
        .strict()
        .parse(body).way,
    ),
  );
  post("setup/again", (body) => setup().again(named.parse(body).id));
  post("setup/code", (body) => setup().code(named.parse(body).id));
  post("setup/test", (body) => setup().sendTest(named.parse(body).id));
  post("setup/confirm", (body) => {
    const read = z.object({ id, arrived: z.boolean() }).strict().parse(body);
    setup().confirm(read.id, read.arrived);
  });
  post("setup/finish", (body) => {
    const read = z.object({ id, enabled: z.boolean() }).strict().parse(body);
    return setup().finish(read.id, read.enabled);
  });
  post("setup/cancel", (body) => setup().cancel(named.parse(body).id));
  post("test", (body) => {
    z.object({}).strict().parse(body);
    return setup().test();
  });
  post("remove", (body) => {
    z.object({}).strict().parse(body);
    return setup().remove();
  });
  post("left-over", (body) => {
    const read = z
      .object({
        item: z.string().max(80),
        elsewhere: z.boolean().default(false),
      })
      .strict()
      .parse(body);
    return setup().removeLeftOver(read.item, read.elsewhere);
  });
}
