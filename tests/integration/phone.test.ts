import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tokenOnly } from "../../src/cli/telegram-setup.js";
import { buildApp } from "../../src/server/api/app.js";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import {
  generateToken,
  KonfabService,
} from "../../src/server/domain/service.js";
import { TelegramError } from "../../src/server/telegram/client.js";
import { TelegramNotices } from "../../src/server/telegram/notices.js";
import { PhoneSetup } from "../../src/server/telegram/setup.js";
import { readSettings } from "../../src/server/telegram/store.js";
import { FakeKeychain } from "../unit/fake-keychain.js";

const TOKEN = "1234567890:MARKEDaabbCCddEEffGGhhIIjjKKllMMnnOO";
const SECRET = TOKEN.split(":")[1]!;
const PORT = 18798;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const CHAT = 987654321;
const CODE = "KONFAB-ABCDE-23456";
const ROUTES = [
  "setup",
  "setup/paste",
  "setup/again",
  "setup/code",
  "setup/test",
  "setup/confirm",
  "setup/finish",
  "setup/cancel",
  "test",
  "remove",
  "left-over",
];

describe("phone notices over the page's routes", () => {
  let home: string;
  let db: Db;
  let service: KonfabService;
  let app: FastifyInstance;
  let cookie: string;
  let agent: string;
  let logs: string;
  let answers: string[];
  let keychain: FakeKeychain;
  let sent: string[];
  let found: boolean;
  let fails: Error | null;

  const call = async (
    method: "GET" | "POST" | "PUT",
    path: string,
    payload?: object | string,
    headers: Record<string, string> = {},
  ) => {
    const answer = await app.inject({
      method,
      url: `/api/phone-notices${path}`,
      headers: {
        host: HOST,
        cookie,
        origin: ORIGIN,
        ...(payload !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...headers,
      },
      ...(payload !== undefined ? { payload } : {}),
    });
    answers.push(answer.body);
    return answer;
  };
  const post = (path: string, body: object = {}) =>
    call("POST", `/${path}`, body);
  const view = async () => (await call("GET", "")).json();
  const until = async (step: string) => {
    for (let i = 0; i < 100; i += 1) {
      const { setup } = await view();
      if (setup?.step === step && !setup.busy) return setup;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error(`It didn't come to ${step}`);
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "konfab-phone-api-"));
    logs = "";
    answers = [];
    sent = [];
    found = false;
    fails = null;
    keychain = new FakeKeychain(TOKEN);
    db = openDatabase(":memory:");
    service = new KonfabService(db, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60_000,
      maxMessageChars: 1000,
    });
    service.ensureAgent("claude", "Claude");
    agent = generateToken();
    service.setAgentToken("claude", agent);
    const client = () => ({
      botName: async () => {
        if (fails) throw fails;
        return "konfab_bot";
      },
      hasWebhook: async () => false,
      waitingMessages: async () => ({
        total: 0,
        messages: found
          ? [
              {
                chat: { id: CHAT, name: "Lead" },
                text: CODE,
                date: Math.floor(Date.now() / 1000) + 1,
              },
            ]
          : [],
      }),
      send: async (chat: number, text: string) => {
        if (fails) throw fails;
        sent.push(`${chat} ${text}`);
      },
    });
    app = await buildApp({
      service,
      port: PORT,
      notices: new TelegramNotices({
        db,
        home,
        options: {
          away_minutes: 10,
          quiet_from: null,
          quiet_to: null,
          room_names: false,
          room_every_minutes: 10,
          max_per_day: 20,
        },
        token: (place) => keychain.read(place),
        client,
      }),
      phoneSetup: new PhoneSetup({
        home,
        keychain: keychain as never,
        client,
        changed: () => service.changed(),
        sleep: () => new Promise((done) => setTimeout(done, 5)),
        code: () => CODE,
      }),
      logger: true,
      logStream: new Writable({
        write(chunk, _encoding, done) {
          logs += String(chunk);
          done();
        },
      }),
    });
    const login = await app.inject({
      method: "GET",
      url: `/login?code=${service.createLoginCode()}`,
      headers: { host: HOST },
    });
    cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
  });
  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const begin = async () => {
    const { setup } = (await post("setup", { way: "terminal" })).json();
    const code = /([A-Z0-9]{6})$/.exec(setup.command)![1]!;
    await tokenOnly(
      {
        home,
        say: () => undefined,
        ask: async () => "y",
        keychain,
        client: () => ({}) as never,
        sleep: async () => undefined,
        now: Date.now,
        code: () => CODE,
      },
      code,
    );
    return (await until("bot")).id as string;
  };

  it("sets up, tests, turns off and removes, and the token is nowhere", async () => {
    expect(await view()).toMatchObject({
      state: "not_set_up",
      setup: null,
      ways: ["paste", "terminal"],
      left_over: [],
    });
    const id = await begin();
    expect((await post("setup/code", { id })).json().setup).toMatchObject({
      step: "code",
      code: CODE,
    });
    found = true;
    await until("chat");
    await post("setup/test", { id });
    await post("setup/confirm", { id, arrived: true });
    const done = await post("setup/finish", { id, enabled: true });
    expect(done.json()).toMatchObject({ state: "on", setup: null });
    expect(sent).toEqual([`${CHAT} Konfab: test`]);
    expect((await post("test")).statusCode).toBe(200);
    expect(sent).toHaveLength(2);
    expect((await call("PUT", "", { enabled: false })).json().state).toBe(
      "off",
    );
    const { item } = readSettings(home)!;
    const everywhere = () =>
      [
        logs,
        ...answers,
        db.serialize().toString("latin1"),
        JSON.stringify(service.overview()),
        ...readdirSync(home).map((name) =>
          readFileSync(join(home, name)).toString("latin1"),
        ),
      ].join("\n");
    expect(everywhere()).not.toContain(SECRET);
    expect([logs, ...answers].join()).not.toContain(String(CHAT));
    expect((await post("remove")).json()).toMatchObject({
      state: "not_set_up",
      left_over: [],
    });
    expect(keychain.removed).toEqual([item]);
    expect(everywhere()).not.toContain(SECRET);
  });

  it("takes a pasted token once, stores it at the end, and gives it back nowhere", async () => {
    const { setup } = (await post("setup", { way: "paste" })).json();
    expect(setup).toMatchObject({ way: "paste", step: "token", command: null });
    const { id } = setup;
    for (const token of [`${TOKEN} x`, "", "1:2", TOKEN.repeat(10)]) {
      const refused = await post("setup/paste", { id, token });
      expect(refused.statusCode).toBe(token.length > 200 ? 400 : 409);
      expect(refused.json().code).toBe("not_a_token");
    }
    const pasted = await post("setup/paste", { id, token: ` ${TOKEN}\n` });
    expect(pasted.json().setup).toMatchObject({
      step: "bot",
      bot: expect.any(String),
    });
    expect(keychain.items.size).toBe(0);
    expect((await post("setup/code", { id })).statusCode).toBe(200);
    found = true;
    await until("chat");
    await post("setup/confirm", { id, arrived: true });
    expect(keychain.items.size).toBe(0);
    const done = await post("setup/finish", { id, enabled: true });
    expect(done.json()).toMatchObject({
      state: "on",
      setup: null,
      left_over: [],
    });
    const { item } = readSettings(home)!;
    expect(keychain.items.get(item!)).toBe(TOKEN);
    expect(
      [
        logs,
        ...answers,
        db.serialize().toString("latin1"),
        ...readdirSync(home).map((name) =>
          readFileSync(join(home, name)).toString("latin1"),
        ),
      ].join("\n"),
    ).not.toContain(SECRET);
  });

  it.each(ROUTES)(
    "is for the signed-in lead on this page only: %s",
    async (path) => {
      const before = keychain.reads.length;
      const body = { way: "terminal", id: "x" };
      for (const headers of <Record<string, string>[]>[
        { cookie: "" },
        { cookie: "", authorization: `Bearer ${agent}` },
        { cookie: "", authorization: "Bearer kfw_abc" },
      ])
        expect((await call("POST", `/${path}`, body, headers)).statusCode).toBe(
          401,
        );
      for (const origin of ["http://evil.example", "null"])
        expect(
          (await call("POST", `/${path}`, body, { origin })).statusCode,
        ).toBe(403);
      const bare = await app.inject({
        method: "POST",
        url: `/api/phone-notices/${path}`,
        headers: { host: HOST, cookie },
        payload: body,
      });
      expect(bare.statusCode).toBe(403);
      expect(await view()).toMatchObject({ setup: null });
      expect(keychain.reads).toHaveLength(before);
      expect(sent).toEqual([]);
    },
  );

  it.each(ROUTES)(
    "quotes nothing of a broken, odd or large request: %s",
    async (path) => {
      for (const payload of [
        TOKEN,
        `{"token": ${TOKEN}}`,
        `{"way":"${TOKEN}`,
        JSON.stringify({ way: TOKEN, id: TOKEN, item: TOKEN, token: TOKEN }),
        JSON.stringify([TOKEN]),
        JSON.stringify({ [TOKEN]: 1 }),
        JSON.stringify({ way: TOKEN.repeat(60) }),
      ]) {
        const answer = await call("POST", `/${path}`, payload);
        expect(answer.statusCode, payload.slice(0, 20)).toBeGreaterThanOrEqual(
          400,
        );
        expect(answer.statusCode).toBeLessThan(500);
        expect(answer.body).not.toContain(SECRET);
      }
      expect(logs).not.toContain(SECRET);
    },
  );

  it("says what went wrong without an address or a raw error", async () => {
    const id = await begin();
    fails = new Error(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    found = true;
    await post("setup/code", { id });
    await until("chat");
    const answer = await post("setup/test", { id });
    expect(answer.json().setup.problem).toBe("Setup had a problem.");
    fails = new TelegramError("Telegram can't be reached.", "no");
    expect((await post("setup/test", { id })).json().setup.problem).toBe(
      "Telegram can't be reached.",
    );
    expect([logs, ...answers].join()).not.toContain(SECRET);
  });

  it("ends a setup by its own number only, also in the middle", async () => {
    const id = await begin();
    const other = "00000000-0000-4000-8000-000000000000";
    expect((await post("setup/cancel", { id: other })).statusCode).toBe(409);
    expect((await post("setup", { way: "terminal" })).statusCode).toBe(409);
    await post("setup/code", { id });
    const [cancelled, late] = await Promise.all([
      post("setup/cancel", { id }),
      post("setup/test", { id }),
    ]);
    expect(cancelled.json()).toMatchObject({ setup: null });
    expect(late.statusCode).toBe(409);
    found = true;
    await new Promise((done) => setTimeout(done, 50));
    const after = await view();
    expect(after).toMatchObject({ state: "not_set_up", setup: null });
    expect(after.left_over).toHaveLength(1);
    const { item } = after.left_over[0];
    expect((await post("left-over", { item })).json().left_over).toEqual([]);
    expect((await post("left-over", { item })).statusCode).toBe(409);
  });

  it("goes on answering while macOS doesn't", async () => {
    const { setup } = (await post("setup", { way: "terminal" })).json();
    let go!: () => void;
    keychain.hold = new Promise((done) => (go = done));
    const storing = tokenOnly(
      {
        home,
        say: () => undefined,
        ask: async () => "y",
        keychain,
        client: () => ({}) as never,
        sleep: async () => undefined,
        now: Date.now,
        code: () => CODE,
      },
      /([A-Z0-9]{6})$/.exec(setup.command)![1],
    );
    const started = Date.now();
    for (let i = 0; i < 5; i += 1) await view();
    expect(Date.now() - started).toBeLessThan(2_000);
    go();
    await storing;
    await until("bot");
  });
});
