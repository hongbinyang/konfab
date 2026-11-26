import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { KonfabError } from "../domain/errors.js";
import type { LiveSettings } from "../live-settings.js";
import { agree, isAgreed, lookAtOwn } from "../rejoin/own-command.js";
import { lookAtCommand } from "../rejoin/codex.js";
import { GithubTokenError, type GithubToken } from "../github/token-store.js";
import { parse } from "yaml";
import {
  changeSettings,
  readSettingsFile,
  SettingsError,
  type Change,
} from "../settings-file.js";
import {
  unusedKeys,
  approvalChange,
  approvalProblem,
  approvalQuestion,
  defaultOf,
  EFFECT,
  questionFor,
  SETTINGS,
  settingFor,
  valueAt,
  withName,
  type Setting,
  type Value,
} from "../settings.js";

export type SettingsAccess = {
  home: string;
  live: LiveSettings;
  /** The Codex command may be another one now. */
  recheck: () => void;
  /** The GitHub token for the skill search, where there is one. */
  github?: GithubToken;
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
    /** The lead said yes to the question of these. */
    confirmed: z.array(z.string()).max(50).default([]),
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
  // The command and pre-approvals have steps of their own.
  const fixed = new Set(
    SETTINGS.filter(
      ({ key, page, control }) =>
        (page === "edit" || page === "ask") &&
        key !== COMMAND &&
        control.type !== "approvals",
    ).map((setting) => setting.key),
  );
  /** An agent's own name and run hours, of the agents in the file. */
  const agentKeys = () =>
    Object.keys(live.saved.agents).flatMap((id) => [
      `agents.${id}.display_name`,
      `agents.${id}.run_hours`,
    ]);
  const editable = (key: string) => fixed.has(key) || agentKeys().includes(key);

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
      settings: [
        ...SETTINGS.filter(({ page }) => page !== "no"),
        ...agentKeys().map((key) => {
          const setting = settingFor(key)!;
          const id = key.split(".")[1]!;
          return {
            ...setting,
            section: "agents" as const,
            name: `${live.saved.agents[id]?.display_name ?? id} · ${setting.name}`,
          };
        }),
      ].map(shownOf),
      /** Never the token: where it comes from, and what is left. */
      github: access.github?.view() ?? null,
      /** Keys in the file that nothing reads any more. */
      unused: (() => {
        try {
          return unusedKeys(parse(readSettingsFile(home).text));
        } catch {
          return [];
        }
      })(),
      /** The lead has to agree to the file that is there now. */
      command_to_agree: look?.ok
        ? !isAgreed(home, look.path, look.stamp)
        : false,
    };
  };

  const save = async (
    change: Change | Parameters<typeof changeSettings>[1],
    hash: string | undefined,
  ) => {
    try {
      const done = await changeSettings(home, change, hash);
      live.look(true);
      if (done.changed)
        deps.changed(
          typeof change === "function"
            ? ["pre_approvals"]
            : [...Object.keys(change.set ?? {}), ...(change.reset ?? [])],
        );
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
      const { hash, set, reset, confirmed } = patch.parse(request.body);
      for (const key of [...Object.keys(set), ...reset])
        if (!editable(key))
          throw new KonfabError(
            "settings_unknown",
            400,
            `${key} can't be changed here`,
          );
      // Asked in the page first; the same question as on the command line.
      for (const [key, next] of [
        ...Object.entries(set),
        ...reset.map((key) => [key, defaultOf(key)] as const),
      ]) {
        const question = questionFor(key, valueAt(live.saved, key), next);
        if (question && !confirmed.includes(key))
          throw new KonfabError("settings_confirm", 409, question);
      }
      return save(
        { set: withName(set as Record<string, Value>, live.saved), reset },
        hash,
      );
    },
  );

  // Exactly the keys the lead was shown, in exactly the file they were
  // shown with; anything newer is refused and shown again.
  app.post(
    "/api/settings/clean",
    { onRequest: fromPage, bodyLimit: 16 * 1024 },
    async (request) => {
      const body = z
        .object({
          hash: z.string().length(64),
          keys: z.array(z.string().max(1000)).min(1).max(200),
        })
        .strict()
        .parse(request.body);
      return save({ drop: body.keys }, body.hash);
    },
  );

  // The token comes once and is never sent back, also not in an error.
  const github = () => {
    if (!access.github)
      throw new KonfabError("not_available", 409, "Not available here");
    return access.github;
  };
  const tokenStep = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      if (error instanceof GithubTokenError)
        throw new KonfabError("github_token", 409, error.message);
      throw new KonfabError(
        "github_token",
        409,
        "That didn't work. Nothing was changed.",
      );
    }
    return view();
  };
  app.post(
    "/api/settings/github-token",
    { onRequest: fromPage, bodyLimit: 4 * 1024 },
    async (request) => {
      const body = z
        .object({ token: z.string().max(300) })
        .strict()
        .safeParse(request.body);
      if (!body.success)
        throw new KonfabError(
          "github_token",
          400,
          "That isn't a GitHub token.",
        );
      return tokenStep(() => github().store(body.data.token));
    },
  );
  app.post(
    "/api/settings/github-token/remove",
    { onRequest: fromPage, bodyLimit: 1024 },
    async (request) => {
      const body = z
        .object({ earlier: z.boolean().default(false) })
        .strict()
        .parse(request.body ?? {});
      return tokenStep(() => github().remove(body.earlier));
    },
  );
  app.post(
    "/api/settings/github-token/remove-earlier",
    { onRequest: fromPage, bodyLimit: 1024 },
    async (request) => {
      z.object({})
        .strict()
        .parse(request.body ?? {});
      return tokenStep(() => github().removeEarlier());
    },
  );

  // One entry at a time, on the list as it is then; an Add only after its
  // question was answered.
  app.post(
    "/api/settings/pre-approvals",
    { onRequest: fromPage, bodyLimit: 4 * 1024 },
    async (request) => {
      const body = z
        .object({
          recipient: z.string().max(1000),
          data: z.string().max(1000),
          add: z.boolean(),
          confirmed: z.boolean().default(false),
        })
        .strict()
        .parse(request.body);
      const approval = { recipient: body.recipient, data: body.data };
      const problem = approvalProblem(approval);
      if (problem) throw new KonfabError("settings_invalid", 400, problem);
      if (body.add && !body.confirmed)
        throw new KonfabError(
          "settings_confirm",
          409,
          approvalQuestion(approval),
        );
      return save(approvalChange(approval, body.add), undefined);
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
