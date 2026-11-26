import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/server/api/app.js";
import { configPath, parseConfig } from "../../src/server/config.js";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import {
  generateToken,
  KonfabService,
} from "../../src/server/domain/service.js";
import { LiveSettings } from "../../src/server/live-settings.js";
import { checked, readSettingsFile } from "../../src/server/settings-file.js";

const PORT = 18797;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;

describe("the settings routes", () => {
  let home: string;
  let db: Db;
  let service: KonfabService;
  let app: FastifyInstance;
  let cookie: string;
  let token: string;
  let applied: number[];
  let rechecks: number;

  const text = () => readFileSync(configPath(home), "utf8");
  const call = (
    method: "GET" | "PATCH" | "POST",
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: { host: HOST, cookie, origin: ORIGIN, ...headers },
      ...(payload ? { payload } : {}),
    });
  const view = async () => (await call("GET", "/api/settings")).json();
  const patch = async (body: object, hash?: string) =>
    call("PATCH", "/api/settings", {
      hash: hash ?? (await view()).hash,
      ...body,
    });
  const of = (seen: { settings: { key: string }[] }, key: string) =>
    seen.settings.find((setting) => setting.key === key);

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "konfab-settings-api-"));
    chmodSync(home, 0o700);
    // Other tests count what commands leave in the usual one.
    vi.stubEnv("TMPDIR", home);
    writeFileSync(
      configPath(home),
      "# mine\nserver:\n  port: 9000\nrejoin:\n  wanted_minutes: 5\n",
    );
    applied = [];
    rechecks = 0;
    db = openDatabase(":memory:");
    service = new KonfabService(db, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60_000,
      maxMessageChars: 1000,
    });
    service.ensureAgent("claude", "Claude");
    token = generateToken();
    service.setAgentToken("claude", token);
    const live = new LiveSettings(
      {
        home,
        port: PORT,
        apply: (next) => applied.push(next.rejoin.wanted_minutes),
        changed: () => service.changed(),
        warn: () => undefined,
      },
      { config: parseConfig(text()), hash: readSettingsFile(home).hash },
    );
    app = await buildApp({
      service,
      port: PORT,
      settings: { home, live, recheck: () => (rechecks += 1) },
    });
    const login = await app.inject({
      method: "GET",
      url: `/login?code=${service.createLoginCode()}`,
      headers: { host: HOST },
    });
    cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("shows what is saved, in use and the default", async () => {
    const seen = await view();
    expect(of(seen, "rejoin.wanted_minutes")).toMatchObject({
      saved: 5,
      in_use: 5,
      default: 10,
      page: "edit",
    });
    expect(seen).toMatchObject({ problem: null, command_to_agree: false });
    expect(of(seen, "agents")).toBeUndefined();
    writeFileSync(configPath(home), "server:\n  port: 9001\n");
    const next = await view();
    expect(of(next, "server.port")).toMatchObject({
      saved: 9001,
      in_use: 9000,
    });
    expect(next.hash).not.toBe(seen.hash);
  });

  it("saves and resets, at once in use, and notes the names only", async () => {
    const saved = await patch({
      set: {
        "rejoin.wanted_minutes": 20,
        "phone_notices.quiet_from": "22:00",
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(of(saved.json(), "rejoin.wanted_minutes")).toMatchObject({
      saved: 20,
      in_use: 20,
    });
    expect(applied).toEqual([20]);
    expect(text()).toContain("# mine");
    expect((await patch({ reset: ["rejoin.wanted_minutes"] })).statusCode).toBe(
      200,
    );
    expect(applied).toEqual([20, 10]);
    const events = db
      .prepare("SELECT payload FROM events WHERE type = 'settings_changed'")
      .all() as { payload: string }[];
    expect(events.map(({ payload }) => JSON.parse(payload).keys)).toEqual([
      ["rejoin.wanted_minutes", "phone_notices.quiet_from"],
      ["rejoin.wanted_minutes"],
    ]);
    expect(JSON.stringify(events)).not.toContain("22:00");
  });

  it("refuses a file that has changed, and says so", async () => {
    const { hash } = await view();
    writeFileSync(configPath(home), "rejoin:\n  wanted_minutes: 7\n");
    const answer = await patch({ set: { "rejoin.enabled": false } }, hash);
    expect(answer.statusCode).toBe(409);
    expect(answer.json().code).toBe("settings_changed");
    expect(text()).toBe("rejoin:\n  wanted_minutes: 7\n");
    expect(applied).toEqual([7]);
  });

  it.each([
    [{ set: { "rejoin.wanted_minutes": 0 } }, "settings_invalid"],
    [{ set: { "rejoin.enabled": "yes" } }, "settings_invalid"],
    [{ set: { "server.port": 9001 } }, "settings_confirm"],
    [{ set: { "defaults.turn_timeout_minutes": 1 } }, "settings_confirm"],
    [{ set: { pre_approvals: "x" } }, "settings_unknown"],
    [{ set: { "rejoin.codex_command": "/opt/x" } }, "settings_unknown"],
    [{ reset: ["rejoin.codex_command"] }, "settings_unknown"],
    [{ set: { "agents.nobody.run_hours": 3 } }, "settings_unknown"],
    [{ set: { "agents.claude.token": "x" } }, "settings_unknown"],
    [{ set: { __proto__x: 1 } }, "settings_unknown"],
    [{ set: { "rejoin.enabled": { a: 1 } } }, "invalid_request"],
    [{ everything: true }, "invalid_request"],
  ])("writes nothing for what it doesn't take (%#)", async (body, code) => {
    const before = text();
    const answer = await patch(body);
    expect([answer.statusCode, answer.json().code]).toEqual([
      code === "settings_confirm" ? 409 : 400,
      code,
    ]);
    expect(text()).toBe(before);
  });

  it("asks first where a change can end something, and takes an agent's own values", async () => {
    const shorter = { set: { "defaults.turn_timeout_minutes": 5 } };
    const asked = await patch(shorter);
    expect(asked.json()).toMatchObject({
      code: "settings_confirm",
      message: expect.stringContaining("ended at the next look"),
    });
    expect(
      (
        await patch({
          ...shorter,
          confirmed: ["defaults.turn_timeout_minutes"],
        })
      ).statusCode,
    ).toBe(200);
    expect(text()).toContain("turn_timeout_minutes: 5");
    const seen = await view();
    expect(of(seen, "agents.claude.run_hours")).toMatchObject({
      section: "agents",
      name: "Claude · Run window",
      saved: null,
    });
    const set = await patch({ set: { "agents.claude.run_hours": 2.5 } });
    expect(set.statusCode, set.body).toBe(200);
    expect(of(await view(), "agents.claude.run_hours")).toMatchObject({
      saved: 2.5,
    });
    expect(
      (await patch({ reset: ["agents.claude.run_hours"] })).statusCode,
    ).toBe(200);
    expect(of(await view(), "agents.claude.run_hours")).toMatchObject({
      saved: null,
    });
  });

  it("adds a pre-approval only after its question, one at a time", async () => {
    const add = (body: object) =>
      call("POST", "/api/settings/pre-approvals", {
        recipient: "github.com/a/b",
        data: "code_push",
        add: true,
        ...body,
      });
    const asked = await add({});
    expect(asked.statusCode).toBe(409);
    expect(asked.json().message).toContain("in every future request");
    expect(text()).not.toContain("pre_approvals");
    // Never around the question, and never by an agent or another page.
    expect((await patch({ set: { pre_approvals: [] } })).json().code).toBe(
      "invalid_request",
    );
    expect((await add({ confirmed: true })).statusCode).toBe(200);
    expect(checked(text()).pre_approvals).toEqual([
      { recipient: "github.com/a/b", data: "code_push" },
    ]);
    const agent = await call(
      "POST",
      "/api/settings/pre-approvals",
      { recipient: "x", data: "y", add: true, confirmed: true },
      { cookie: "", authorization: `Bearer ${token}` },
    );
    expect(agent.statusCode).toBe(401);
    const other = await call(
      "POST",
      "/api/settings/pre-approvals",
      { recipient: "x", data: "y", add: true, confirmed: true },
      { origin: "http://evil.example" },
    );
    expect(other.statusCode).toBe(403);
    expect((await add({ recipient: "  ", confirmed: true })).statusCode).toBe(
      400,
    );
    expect((await add({ add: false })).statusCode).toBe(200);
    expect(checked(text()).pre_approvals).toEqual([]);
  });

  it("shows keys that nothing reads, and removes only them, from this page", async () => {
    writeFileSync(
      configPath(home),
      `${text()}defaults:\n  hours: { start: "09:00", end: "18:00", days: [mon] }\nui:\n  x: 1\n`,
    );
    expect((await view()).unused).toEqual(["defaults.hours", "ui"]);
    expect(
      (
        await call(
          "POST",
          "/api/settings/clean",
          {},
          {
            origin: "http://evil.example",
          },
        )
      ).statusCode,
    ).toBe(403);
    const seen = await view();
    // Another writer adds a key after the lead was shown the list.
    writeFileSync(configPath(home), `${text()}future:\n  y: 2\n`);
    const late = await call("POST", "/api/settings/clean", {
      hash: seen.hash,
      keys: seen.unused,
    });
    expect([late.statusCode, late.json().code]).toEqual([
      409,
      "settings_changed",
    ]);
    expect(text()).toContain("future:");
    const again = await view();
    expect(again.unused).toEqual(["defaults.hours", "ui", "future"]);
    // Only what was shown, never a key in use.
    expect(
      (
        await call("POST", "/api/settings/clean", {
          hash: again.hash,
          keys: ["server.port"],
        })
      ).statusCode,
    ).toBe(400);
    const done = await call("POST", "/api/settings/clean", {
      hash: again.hash,
      keys: ["defaults.hours", "ui"],
    });
    expect(done.json().unused).toEqual(["future"]);
    await call("POST", "/api/settings/clean", {
      hash: done.json().hash,
      keys: ["future"],
    });
    expect(text()).toBe(
      "# mine\nserver:\n  port: 9000\nrejoin:\n  wanted_minutes: 5\n",
    );
  });

  it("says what is wrong with a broken file, and saves nothing over it", async () => {
    writeFileSync(configPath(home), "rejoin: {\n");
    const seen = await view();
    expect(seen.problem).toContain("line");
    expect(of(seen, "rejoin.wanted_minutes")).toMatchObject({ in_use: 5 });
    const answer = await patch({ set: { "rejoin.enabled": false } });
    expect(answer.statusCode).toBe(409);
    expect(text()).toBe("rejoin: {\n");
  });

  it("takes another command only in its own steps, for exactly the file that was looked at", async () => {
    const path = "/usr/bin/true";
    const look = (
      await call("POST", "/api/settings/codex-command/look", { path })
    ).json();
    if (process.platform === "win32") return;
    expect(look).toMatchObject({ ok: true, path });
    const send = async (body: object) =>
      call("POST", "/api/settings/codex-command", {
        hash: (await view()).hash,
        ...body,
      });
    expect((await send({ path, stamp: "other" })).statusCode).toBe(409);
    expect((await send({ path })).statusCode).toBe(409);
    expect((await send({ path: "relative", stamp: "x" })).statusCode).toBe(409);
    expect(text()).not.toContain("codex_command");
    expect(rechecks).toBe(0);
    const saved = await send({ path, stamp: look.stamp });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ command_to_agree: false });
    expect(text()).toContain(`codex_command: ${path}`);
    expect(rechecks).toBe(1);
    // Changed by hand: it has to be agreed to.
    writeFileSync(configPath(home), text().replace(path, "/usr/bin/false"));
    expect((await view()).command_to_agree).toBe(true);
    const back = await send({ path: null });
    expect(back.json()).toMatchObject({ command_to_agree: false });
    expect(text()).not.toContain("codex_command");
  });

  it("is for the signed-in lead on this page only", async () => {
    const before = text();
    const { hash } = await view();
    const routes: ["PATCH" | "POST", string, object][] = [
      ["PATCH", "/api/settings", { hash, set: { "rejoin.enabled": false } }],
      ["POST", "/api/settings/codex-command/look", { path: "/usr/bin/true" }],
      ["POST", "/api/settings/codex-command", { hash, path: null }],
    ];
    for (const [method, url, body] of routes) {
      const codes = [];
      for (const headers of [
        { cookie: "" },
        { cookie: "", authorization: `Bearer ${token}` },
        { cookie: "", authorization: "Bearer kfw_x" },
      ])
        codes.push(
          (await call(method, url, body, headers as never)).statusCode,
        );
      expect(codes, url).toEqual([401, 401, 401]);
      for (const origin of ["http://evil.example", "null"])
        expect((await call(method, url, body, { origin })).statusCode).toBe(
          403,
        );
      // The lead's cookie without this page's own origin.
      const bare = await app.inject({
        method,
        url,
        headers: { host: HOST, cookie },
        payload: body,
      });
      expect(bare.statusCode, url).toBe(403);
    }
    expect(
      (await call("GET", "/api/settings", undefined, { cookie: "" }))
        .statusCode,
    ).toBe(401);
    expect(text()).toBe(before);
  });
});
