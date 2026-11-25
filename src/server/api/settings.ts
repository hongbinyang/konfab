import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { KonfabError } from "../domain/errors.js";
import type { LiveSettings } from "../live-settings.js";
import { agree, isAgreed, lookAtOwn } from "../rejoin/own-command.js";
import { lookAtCommand } from "../rejoin/codex.js";
import {
  changeSettings,
  SettingsError,
  type Change,
} from "../settings-file.js";
import {
  defaultOf,
  EFFECT,
  SETTINGS,
  valueAt,
  type Setting,
  type Value,
} from "../settings.js";

export type SettingsAccess = {
  home: string;
  live: LiveSettings;
  /** The Codex command may be another one now. */
  recheck: () => void;
  /** Test seam: what starts codesign. */
  run?: Parameters<typeof lookAtOwn>[2];
};

const COMMAND = "rejoin.codex_command";
const value = z.union([
  z.string().max(1000),
  z.number(),
  z.boolean(),
  z.null(),
]);
const patch = z
  .object({
    hash: z.string().length(64),
    set: z.record(z.string(), value).default({}),
    reset: z.array(z.string()).max(50).default([]),
  })
  .strict();
const path = z.string().min(1).max(1000);

/** The lead's settings. Agents have no route to these. */
export function settingsRoutes(
  app: FastifyInstance,
  access: SettingsAccess,
  deps: { origins: Set<string>; changed: (keys: string[]) => void },
): void {
  const { home, live } = access;
  const editable = new Map(
    SETTINGS.filter(
      ({ key, page }) => (page === "edit" || page === "ask") && key !== COMMAND,
    ).map((setting) => [setting.key, setting]),
  );

  /** A change comes from this page itself, and from no other program's call. */
  const fromPage = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!deps.origins.has(request.headers.origin ?? ""))
      return reply
        .code(403)
        .send({ code: "forbidden", message: "Request not allowed" });
  };

  const view = () => {
    live.look();
    const shownOf = (setting: Setting) => ({
      ...setting,
      effect_text: EFFECT[setting.effect],
      saved: (valueAt(live.saved, setting.key) ?? null) as Value,
      in_use: (valueAt(live.inUse, setting.key) ?? null) as Value,
      default: (defaultOf(setting.key) ?? null) as Value,
    });
    const command = live.inUse.rejoin.codex_command;
    const look = command === null ? null : lookAtCommand(command);
    return {
      hash: live.hash,
      problem: live.problem,
      platform: process.platform,
      settings: SETTINGS.filter(({ page }) => page !== "no").map(shownOf),
      /** The lead has to agree to the file that is there now. */
      command_to_agree: look?.ok
        ? !isAgreed(home, look.path, look.stamp)
        : false,
    };
  };

  const save = async (change: Change, hash: string) => {
    try {
      const done = await changeSettings(home, change, hash);
      live.look(true);
      if (done.changed)
        deps.changed([
          ...Object.keys(change.set ?? {}),
          ...(change.reset ?? []),
        ]);
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      live.look(true);
      throw new KonfabError(
        `settings_${error.code}`,
        error.code === "invalid" || error.code === "unknown" ? 400 : 409,
        error.message,
      );
    }
    return view();
  };

  app.get("/api/settings", async () => view());

  app.patch(
    "/api/settings",
    { onRequest: fromPage, bodyLimit: 16 * 1024 },
    async (request) => {
      const { hash, set, reset } = patch.parse(request.body);
      for (const key of [...Object.keys(set), ...reset])
        if (!editable.has(key))
          throw new KonfabError(
            "settings_unknown",
            400,
            `${key} can't be changed here`,
          );
      return save({ set: set as Record<string, Value>, reset }, hash);
    },
  );

  // Its own two steps: what can be seen without running it, and the yes to
  // exactly that file.
  app.post(
    "/api/settings/codex-command/look",
    { onRequest: fromPage, bodyLimit: 4 * 1024 },
    async (request) => {
      const body = z.object({ path }).strict().parse(request.body);
      const look = await lookAtOwn(body.path, home, access.run);
      return look.ok
        ? {
            ok: true,
            path: look.path,
            stamp: look.stamp,
            signed_by: look.signed_by,
          }
        : { ok: false, reason: look.reason };
    },
  );
  app.post(
    "/api/settings/codex-command",
    { onRequest: fromPage, bodyLimit: 4 * 1024 },
    async (request) => {
      const body = z
        .object({
          hash: z.string().length(64),
          /** null: the app's own again. */
          path: path.nullable(),
          stamp: z.string().max(200).optional(),
        })
        .strict()
        .parse(request.body);
      if (body.path === null) {
        const saved = await save({ reset: [COMMAND] }, body.hash);
        agree(home, null);
        access.recheck();
        return { ...saved, command_to_agree: false };
      }
      const look = await lookAtOwn(body.path, home, access.run);
      if (!look.ok || look.stamp !== body.stamp)
        throw new KonfabError(
          "settings_changed",
          409,
          look.ok ? "The file has changed; look again" : look.reason,
        );
      // Saved first: if that fails, nothing is agreed to.
      await save({ set: { [COMMAND]: look.path } }, body.hash);
      agree(home, { path: look.path, stamp: look.stamp });
      access.recheck();
      return view();
    },
  );
}
