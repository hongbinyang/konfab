import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCode, setupTelegram } from "../../src/cli/telegram-setup.js";
import { buildApp } from "../../src/server/api/app.js";
import { parseConfig } from "../../src/server/config.js";
import { openDatabase, type Db } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";
import {
  TelegramClient,
  TelegramError,
} from "../../src/server/telegram/client.js";
import {
  noticeText,
  TelegramNotices,
} from "../../src/server/telegram/notices.js";
import {
  readSettings,
  settingsPath,
  statePath,
  writeSettings,
} from "../../src/server/telegram/store.js";
import { readNotes } from "../../src/server/telegram/places.js";
import {
  Keychain,
  newItem,
  type TokenRead,
} from "../../src/server/telegram/token.js";
import { FakeKeychain } from "./fake-keychain.js";

// Made up; no test contacts Telegram.
const TOKEN = "1234567890:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr";
const CHAT = 987654321;

type Call = { method: string; body: Record<string, unknown> };
type Reply = {
  status?: number;
  body?: unknown;
  hang?: boolean;
  drop?: boolean;
};

/** A stand-in for Telegram on this computer. */
class StandIn {
  calls: Call[] = [];
  replies = new Map<string, Reply | ((call: Call) => Reply)>();
  private server!: Server;
  url = "";
  async start() {
    this.server = createServer((request, response) => {
      let text = "";
      request.on("data", (chunk) => (text += String(chunk)));
      request.on("end", () => {
        const match = new RegExp(`^/bot${TOKEN}/(\\w+)$`).exec(
          request.url ?? "",
        );
        const call = {
          method: match?.[1] ?? "?",
          body: JSON.parse(text || "{}") as Record<string, unknown>,
        };
        this.calls.push(call);
        const set = this.replies.get(call.method);
        const reply = typeof set === "function" ? set(call) : set;
        if (reply?.hang) return;
        if (reply?.drop) return void request.socket.destroy();
        response.statusCode = reply?.status ?? 200;
        if (response.statusCode === 302)
          response.setHeader("Location", `${this.url}/elsewhere`);
        response.end(
          JSON.stringify(
            reply?.body ?? {
              ok: true,
              result:
                call.method === "getMe"
                  ? { username: "konfab_test_bot" }
                  : call.method === "getWebhookInfo"
                    ? { url: "" }
                    : call.method === "getUpdates"
                      ? []
                      : {},
            },
          ),
        );
      });
    }).listen(0, "127.0.0.1");
    await new Promise((done) => this.server.once("listening", done));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise((done) => this.server.close(done));
  }
  sent = () =>
    this.calls
      .filter((call) => call.method === "sendMessage")
      .map((call) => call.body.text);
}

let telegram: StandIn;
let home: string;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "konfab-telegram-"));
  telegram = new StandIn();
  await telegram.start();
});
afterEach(async () => {
  await telegram.stop();
  rmSync(home, { recursive: true, force: true });
});
const client = (timeoutMs = 2_000) =>
  new TelegramClient(TOKEN, telegram.url, timeoutMs);

describe("the Telegram client", () => {
  const failure = async (): Promise<TelegramError> =>
    client(300)
      .send(CHAT, "x")
      .then(
        () => {
          throw new Error("it was sent");
        },
        (error: TelegramError) => error,
      );

  it.each([
    ["a bad token", { status: 401, body: { ok: false } }, "never"],
    ["a blocked bot", { status: 403, body: { ok: false } }, "never"],
    ["a missing chat", { status: 400, body: { ok: false } }, "never"],
    ["another reader", { status: 409, body: { ok: false } }, "never"],
    ["its own problem", { status: 502, body: "<html>" }, "maybe"],
    ["a strange answer", { body: "no" }, "maybe"],
    ["no answer", { hang: true }, "maybe"],
    ["a lost connection", { drop: true }, "maybe"],
    ["a redirect", { status: 302, body: {} }, "maybe"],
  ] as [string, Reply, string][])(
    "says whether a notice arrived after %s, and never shows the token",
    async (_name, reply, delivered) => {
      telegram.replies.set("sendMessage", reply);
      const error = await failure();
      expect(error).toBeInstanceOf(TelegramError);
      expect(error.delivered).toBe(delivered);
      const all = `${error.message} ${error.stack} ${JSON.stringify(error)} ${String(error.cause)}`;
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain(TOKEN.split(":")[1]);
      expect(all).not.toContain("127.0.0.1");
      // A redirect is never followed.
      expect(telegram.calls).toHaveLength(1);
    },
  );

  it("waits as long as Telegram asks, and knows when it wasn't reached", async () => {
    telegram.replies.set("sendMessage", {
      status: 429,
      body: { ok: false, parameters: { retry_after: 17 } },
    });
    expect(await failure()).toMatchObject({
      delivered: "no",
      retryAfterSeconds: 17,
    });
    // A port that nothing listens on any more.
    const closed = new StandIn();
    await closed.start();
    await closed.stop();
    const gone = new TelegramClient(TOKEN, closed.url, 2_000);
    await expect(gone.send(CHAT, "x")).rejects.toMatchObject({
      delivered: "no",
    });
  });

  it("never confirms waiting messages", async () => {
    await client().waitingMessages();
    expect(telegram.calls[0]?.body).toEqual({ limit: 100, timeout: 0 });
  });

  it("reads only a token that looks like one, from its own place, and none when isolated", async () => {
    const asked: string[][] = [];
    const of = (
      env: NodeJS.ProcessEnv,
      platform: string,
      code = 0,
      out = TOKEN,
    ) =>
      new Keychain(env, platform as NodeJS.Platform, async (args) => {
        asked.push(args);
        return { code, out };
      });
    const b = { slot: "b" } as const;
    const found = { state: "found", token: TOKEN };
    const env = { KONFAB_TELEGRAM_TOKEN: TOKEN };
    expect(await of({}, "darwin").read(b)).toEqual(found);
    expect(asked).toEqual([
      [
        "find-generic-password",
        "-a",
        expect.any(String),
        "-s",
        "konfab-telegram-token-b",
        "-w",
      ],
    ]);
    // The environment never stands in for the Keychain, or the other way.
    expect(await of(env, "darwin", 44).read(b)).toEqual({ state: "none" });
    expect(await of({}, "darwin").read({ slot: "env" })).toEqual({
      state: "none",
    });
    expect(await of(env, "linux").read({ slot: "env" })).toEqual(found);
    expect(await of({}, "linux").read(b)).toEqual({ state: "none" });
    expect(await of({ KONFAB_ISOLATED: "1" }, "darwin").read(b)).toEqual({
      state: "none",
    });
    expect(asked).toHaveLength(2);
  });

  it("takes only macOS's own answer for nothing as nothing", async () => {
    const of = (run: () => Promise<{ code: number | null; out: string }>) =>
      new Keychain({}, "darwin", run);
    const unknown = { state: "unknown" };
    for (const [code, out] of [
      [1, ""],
      [36, ""],
      [51, TOKEN],
      [128, ""],
      [null, ""],
      [0, ""],
      [0, "not a token"],
      [0, `${TOKEN}\nmore`],
    ] as const) {
      const keychain = of(async () => ({ code, out }));
      expect(await keychain.read({ slot: "a" }), `${code}`).toEqual(unknown);
    }
    const breaks = of(() => Promise.reject(new Error("no")));
    expect(await breaks.read({ slot: "a" })).toEqual(unknown);
    expect(await breaks.remove("konfab-telegram-token-a")).toBe("unknown");
    for (const [code, result] of [
      [0, "deleted"],
      [44, "none"],
      [1, "unknown"],
      [null, "unknown"],
    ] as const)
      expect(
        await of(async () => ({ code, out: "" })).remove(
          "konfab-telegram-token-b",
        ),
      ).toBe(result);
  });

  it("stores a pasted token through the input of macOS's command, never its arguments", async () => {
    const lines: [string, number][] = [];
    let started = 0;
    const of = (env: NodeJS.ProcessEnv = {}, platform = "darwin", code = 0) =>
      new Keychain(
        env,
        platform as NodeJS.Platform,
        async () => {
          started += 1;
          return { code: 0, out: "" };
        },
        {
          input: async (line, limit) => {
            lines.push([line, limit]);
            return code;
          },
        },
      );
    const item = newItem();
    expect(await of().store(item, TOKEN)).toBe(true);
    expect(lines).toEqual([
      [
        `add-generic-password -a ${userInfo().username} -s ${item} -w ${TOKEN}\n`,
        60_000,
      ],
    ]);
    // Never "replace" (-U): an item that is there is refused.
    expect(lines[0]![0]).not.toContain(" -U");
    expect(await of({}, "darwin", 45).store(item, TOKEN)).toBe(false);
    lines.length = 0;
    for (const [keychain, name, token] of [
      [of({ KONFAB_ISOLATED: "1" }), item, TOKEN],
      [of({}, "win32"), item, TOKEN],
      [of(), "login", TOKEN],
      [of(), item, `${TOKEN} -U`],
      [of(), item, "not a token"],
    ] as const)
      expect(await keychain.store(name, token)).toBe(false);
    expect(lines).toEqual([]);
    expect(started).toBe(0);
  });

  it("asks macOS only for names that Konfab makes", async () => {
    let started = 0;
    const keychain = new Keychain({}, "darwin", async () => {
      started += 1;
      return { code: 0, out: TOKEN };
    });
    for (const item of [
      "",
      "login",
      "konfab-telegram-token-c",
      "konfab-telegram-token-",
      `konfab-telegram-token-${"0".repeat(31)}`,
      `konfab-telegram-token-${"0".repeat(32)} -w`,
    ]) {
      expect(await keychain.remove(item)).toBe("unknown");
      expect(await keychain.read({ slot: "own", item })).toEqual({
        state: "unknown",
      });
      expect(await keychain.storeByHand(item)).toBe(false);
    }
    expect(started).toBe(0);
  });
});

describe("setting up phone notices", () => {
  let said: string;
  let asked: string[];
  let time: number;
  const CODE = "KONFAB-ABCDE-23456";
  const message = (
    change: object = {},
    chat: object = {},
    from: object = {},
  ) => ({
    update_id: 1,
    message: {
      date: Math.floor(time / 1000) + 1,
      text: CODE,
      chat: { id: CHAT, type: "private", first_name: "Lead", ...chat },
      from: { id: CHAT, is_bot: false, ...from },
      ...change,
    },
  });
  const updates = (...items: object[]) =>
    telegram.replies.set("getUpdates", () => ({
      body: {
        ok: true,
        // None before the code was shown.
        result: said.includes(CODE) ? items : [],
      },
    }));
  /** Answers questions by a part of their text; anything else is a no. */
  let keychain: FakeKeychain;
  const run = (
    answers: Record<string, string>,
    change: Partial<Parameters<typeof setupTelegram>[0]> = {},
  ) =>
    setupTelegram({
      home,
      say: (line) => (said += `${line}\n`),
      ask: async (question) => {
        asked.push(question);
        const key = Object.keys(answers).find((part) =>
          question.includes(part),
        );
        return key === undefined ? "" : (answers[key] as string);
      },
      keychain,
      client: () => client(),
      sleep: async (ms) => {
        time += ms;
      },
      now: () => time,
      code: () => CODE,
      ...change,
    });
  const ALL = {
    "contact Telegram": "y",
    "by a code": "y",
    "Send Konfab's notices": "y",
    "Konfab: test": "y",
    "Did it arrive": "y",
    "Turn phone notices on": "y",
  };
  beforeEach(() => {
    said = "";
    asked = [];
    keychain = new FakeKeychain(TOKEN);
    time = 1_800_000_000_000;
  });

  it("contacts Telegram only after a yes, and sends only after more", async () => {
    expect(await run({})).toBe(false);
    expect(telegram.calls).toEqual([]);
    updates(message());
    expect(await run({ ...ALL, "Konfab: test": "n" })).toBe(true);
    expect(telegram.sent()).toEqual([]);
    expect(await run(ALL)).toBe(true);
    expect(telegram.sent()).toEqual(["Konfab: test"]);
    expect(readSettings(home)).toEqual({
      chat_id: CHAT,
      chat_name: "Lead",
      enabled: true,
      slot: "own",
      item: expect.stringMatching(/^konfab-telegram-token-[0-9a-f]{32}$/),
      bot_id: "1234567890",
      setup_id: expect.any(String),
    });
    // The replaced setup's token is gone.
    expect([...keychain.items.keys()]).toEqual([readSettings(home)!.item]);
    expect(readNotes(home)).toEqual([]);
    if (process.platform !== "win32")
      expect(statSync(settingsPath(home)).mode & 0o777).toBe(0o600);
    expect(said).not.toContain(TOKEN);
    expect(said).not.toContain(String(CHAT));
  });

  it("stays off unless turned on, and is nothing without the last confirmations", async () => {
    updates(message());
    for (const [change, kept] of [
      [{ "Send Konfab's notices": "n" }, null],
      [{ "Did it arrive": "n" }, null],
      [{ "Turn phone notices on": "n" }, false],
    ] as const) {
      said = "";
      rmSync(settingsPath(home), { force: true });
      await run({ ...ALL, ...change });
      expect(readSettings(home)?.enabled ?? null).toBe(kept);
    }
  });

  it.each([
    ["another text", () => message({ text: `${CODE} please` })],
    ["a group", () => message({}, { id: -5, type: "group" })],
    ["someone else in a private chat", () => message({}, {}, { id: 5 })],
    ["a bot", () => message({}, {}, { is_bot: true })],
    ["a forwarded code", () => message({ forward_origin: { type: "user" } })],
    ["an old message", () => message({ date: Math.floor(time / 1000) - 600 })],
  ])("doesn't accept the code from %s", async (_name, make) => {
    updates(make());
    expect(await run(ALL)).toBe(false);
    expect(said).toContain("didn't arrive in time");
    expect(existsSync(settingsPath(home))).toBe(false);
    expect(telegram.sent()).toEqual([]);
  });

  it("leaves a bot alone that something else uses", async () => {
    telegram.replies.set("getWebhookInfo", {
      body: { ok: true, result: { url: "https://example.com" } },
    });
    expect(await run(ALL)).toBe(false);
    telegram.replies.delete("getWebhookInfo");
    telegram.replies.set("getUpdates", { status: 409, body: { ok: false } });
    expect(await run(ALL)).toBe(false);
    expect(said).toContain("Something else is reading this bot");
    telegram.replies.set("getUpdates", {
      body: { ok: true, result: Array.from({ length: 60 }, () => message()) },
    });
    expect(await run(ALL)).toBe(false);
    expect(said).toContain("isn't a new one");
    expect(new Set(telegram.calls.map((call) => call.method))).toEqual(
      new Set(["getMe", "getWebhookInfo", "getUpdates"]),
    );
  });

  it("takes a typed chat number without reading, but only after the test arrived", async () => {
    const typed = { ...ALL, "by a code": "n", "Type your chat": String(CHAT) };
    expect(await run({ ...typed, "Konfab: test": "n" })).toBe(false);
    expect(await run({ ...typed, "Did it arrive": "n" })).toBe(false);
    expect(await run({ ...typed, "Type your chat": "-100" })).toBe(false);
    expect(readSettings(home)).toBeNull();
    expect(await run(typed)).toBe(true);
    expect(telegram.calls.some((call) => call.method === "getUpdates")).toBe(
      false,
    );
    expect(readSettings(home)?.chat_id).toBe(CHAT);
  });

  describe("replacing a working setup", () => {
    const OLD_TOKEN = "5555555555:ZZbbCCddEEffGGhhIIjjKKllMMnnOOppQQr";
    const old = {
      chat_id: 111,
      chat_name: "Old chat",
      enabled: true,
      slot: "a" as const,
      bot_id: "5555555555",
      setup_id: "old-setup",
    };
    let file: string;
    beforeEach(() => {
      writeSettings(home, old);
      file = readFileSync(settingsPath(home), "utf8");
      keychain.items.set("konfab-telegram-token-a", OLD_TOKEN);
      updates(message());
    });
    /** Byte for byte, with its own token, and nothing left of the new one. */
    const untouched = () => {
      expect(readFileSync(settingsPath(home), "utf8")).toBe(file);
      expect([...keychain.items]).toEqual([
        ["konfab-telegram-token-a", OLD_TOKEN],
      ]);
      expect(readNotes(home)).toEqual([]);
      expect(
        readdirSync(home).filter((name) => !name.startsWith("config.lock")),
      ).toEqual(["telegram.json"]);
    };

    it.each(Object.keys(ALL))(
      "leaves it untouched when the lead stops at %j",
      async (question) => {
        const stopped = await run({ ...ALL, [question]: "n" });
        if (
          question === "Konfab: test" ||
          question === "Turn phone notices on"
        ) {
          // These two are choices within a complete setup.
          expect(stopped).toBe(true);
          expect(readSettings(home)?.chat_id).toBe(CHAT);
          return;
        }
        expect(stopped).toBe(false);
        untouched();
      },
    );

    it.each([
      ["getMe", { status: 401, body: { ok: false } }],
      ["getMe", { hang: true }],
      ["getWebhookInfo", { status: 502, body: {} }],
      [
        "getWebhookInfo",
        { body: { ok: true, result: { url: "https://example.com" } } },
      ],
      ["getUpdates", { status: 409, body: { ok: false } }],
      ["getUpdates", { drop: true }],
      ["sendMessage", { status: 403, body: { ok: false } }],
      ["sendMessage", { drop: true }],
    ] as [string, Reply][])(
      "leaves it untouched when %s fails (%j)",
      async (method, reply) => {
        telegram.replies.set(method, reply);
        expect(await run(ALL, { client: () => client(300) })).toBe(false);
        untouched();
        expect(said).toContain("the earlier setup is as it was");
        expect(said).not.toContain(TOKEN);
      },
    );

    it.each([
      ["saving the token is refused", () => (keychain.refuses = true)],
      ["saving the token breaks", () => (keychain.breaks = true)],
    ])("leaves it untouched when %s", async (_name, spoil) => {
      spoil();
      expect(await run(ALL)).toBe(false);
      untouched();
      expect(telegram.sent()).toEqual([]);
    });

    it("leaves it untouched when the client can't be made", async () => {
      expect(
        await run(ALL, {
          client: () => {
            throw new Error("broken");
          },
        }),
      ).toBe(false);
      untouched();
    });

    it("keeps a note, and deletes nothing, when it isn't known whether the token was saved", async () => {
      keychain.unknown = true;
      expect(await run(ALL)).toBe(false);
      expect(readFileSync(settingsPath(home), "utf8")).toBe(file);
      expect(readNotes(home)).toMatchObject([{ state: "unknown" }]);
      expect(keychain.removed).toEqual([]);
      expect(telegram.calls).toEqual([]);
    });

    it("doesn't undo what was changed while it ran", async () => {
      for (const change of [
        () => rmSync(settingsPath(home)),
        () => writeSettings(home, { ...old, setup_id: "another" }),
      ]) {
        writeSettings(home, old);
        said = "";
        updates(message());
        expect(
          await run(ALL, {
            ask: async (question) => {
              if (question.includes("Turn phone")) change();
              return "y";
            },
          }),
        ).toBe(false);
        expect(said).toContain("changed meanwhile");
        expect(readSettings(home)?.setup_id ?? null).not.toBe("old-setup");
        expect(readSettings(home)?.chat_id ?? null).not.toBe(CHAT);
        expect([...keychain.items.keys()]).toEqual(["konfab-telegram-token-a"]);
      }
      // Off meanwhile is the same setup: it is replaced, as was asked.
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "leaves it untouched when the new settings can't be written",
      async () => {
        chmodSync(home, 0o500);
        try {
          expect(await run(ALL)).toBe(false);
        } finally {
          chmodSync(home, 0o700);
        }
        untouched();
        expect(said).toContain("the earlier setup is as it was");
      },
    );

    it("is as it was if setup is killed at any question", async () => {
      const questions = (await run(ALL), asked.length);
      for (let at = 1; at <= questions; at += 1) {
        writeSettings(home, old);
        keychain = new FakeKeychain(TOKEN);
        keychain.items.set("konfab-telegram-token-a", OLD_TOKEN);
        rmSync(join(home, "telegram-notes.json"), { force: true });
        said = "";
        updates(message());
        let count = 0;
        // Never answered: the process ends here, with nothing cleaned up.
        void run(ALL, {
          ask: () => {
            count += 1;
            return count === at
              ? new Promise<string>(() => undefined)
              : Promise.resolve("y");
          },
        });
        for (let wait = 0; wait < 200 && count < at; wait += 1)
          await new Promise((done) => setTimeout(done, 5));
        expect(count).toBe(at);
        expect(readFileSync(settingsPath(home), "utf8")).toBe(file);
        expect(keychain.items.get("konfab-telegram-token-a")).toBe(OLD_TOKEN);
        expect(keychain.removed).toEqual([]);
        // What may be stored has its note.
        expect(
          [...keychain.items.keys()].filter(
            (item) =>
              item !== "konfab-telegram-token-a" &&
              !readNotes(home).some((note) => note.item === item),
          ),
        ).toEqual([]);
      }
    });

    it("goes on sending with the old bot to the old chat until the new one is complete, then only with the new", async () => {
      const db = openDatabase(":memory:");
      const used: string[] = [];
      let at = time;
      const sender = () =>
        new TelegramNotices({
          db,
          home,
          options: {
            away_minutes: 1,
            quiet_from: null,
            quiet_to: null,
            room_names: false,
            message_text: false,
            room_every_minutes: 1,
            max_per_day: 100,
          },
          token: (place) => keychain.read(place),
          client: (token) => ({
            send: async (chat) => {
              used.push(`${token.split(":")[0]} ${chat}`);
            },
          }),
          now: () => at,
        });
      const service = new KonfabService(db, {
        now: () => at,
        waitTimeoutSeconds: 50,
        turnTimeoutMs: 60_000_000,
        maxMessageChars: 1000,
        runHoursFor: () => 24,
      });
      service.ensureAgent("claude", "Claude");
      service.createRoom("r", "", ["claude"]);
      const session = service.join("claude", "r").session_id;
      const notices = sender();
      await notices.tick();
      const event = async (look: TelegramNotices) => {
        service.reportStatus("claude", session, "blocked", "x");
        at += 5 * 60_000;
        await look.tick();
      };
      await event(notices);
      let during = 0;
      await run(ALL, {
        ask: async (question) => {
          if (question.includes("Did it arrive")) {
            await event(notices);
            during = used.length;
          }
          return "y";
        },
      });
      expect(used).toEqual(["5555555555 111", "5555555555 111"]);
      expect(during).toBe(2);
      // Something from before the new setup isn't sent by it.
      await notices.tick();
      await event(notices);
      expect(used.at(-1)).toBe(`1234567890 ${CHAT}`);
      expect(used).toHaveLength(3);
      // Also after a restart.
      at += 60_000;
      const restarted = sender();
      await event(restarted);
      expect(used.at(-1)).toBe(`1234567890 ${CHAT}`);
      db.close();
    });

    it("never deletes the place of an earlier version, which another folder may use", async () => {
      expect(await run(ALL)).toBe(true);
      expect(readSettings(home)?.slot).toBe("own");
      expect(keychain.items.get("konfab-telegram-token-a")).toBe(OLD_TOKEN);
      expect(keychain.removed).toEqual([]);
      expect(said).toContain("another Konfab folder of yours may use it");
      expect(readNotes(home)).toMatchObject([
        { item: "konfab-telegram-token-a", state: "unused" },
      ]);
    });

    it("says when a replaced token couldn't be removed; it isn't used any more", async () => {
      await run(ALL);
      const first = readSettings(home)!.item!;
      keychain.keeps = true;
      said = "";
      updates(message());
      expect(await run(ALL)).toBe(true);
      expect(readSettings(home)?.item).not.toBe(first);
      expect(said).toContain(first);
      expect(readNotes(home)).toContainEqual(
        expect.objectContaining({ item: first, state: "unused" }),
      );
    });
  });

  it("makes codes that can't be guessed", () => {
    const codes = new Set(Array.from({ length: 200 }, newCode));
    expect(codes.size).toBe(200);
    for (const code of codes)
      expect(code).toMatch(/^KONFAB-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  });
});

describe("phone notices", () => {
  let db: Db;
  let now: number;
  let service: KonfabService;
  let notices: TelegramNotices;
  let claude: string;
  let warnings: string[];
  const MINUTE = 60_000;
  const SECRET = "secret message text";
  const make = (options: object = {}) =>
    new TelegramNotices({
      db,
      home,
      options: {
        away_minutes: 10,
        quiet_from: null,
        quiet_to: null,
        room_names: false,
        message_text: false,
        room_every_minutes: 10,
        max_per_day: 20,
        ...options,
      },
      token: async () => ({ state: "found", token: TOKEN }) as TokenRead,
      client: () => client(300),
      now: () => now,
      warn: (text) => warnings.push(text),
    });
  /** As an agent would, in its own turn. */
  const mention = (body = `@lead ${SECRET}`, room = "private-room") => {
    service.postUserMessage(room, "@claude go");
    const turn = service.poll("claude", claude, true) as { turn_id: number };
    return service.postAgentMessage("claude", claude, turn.turn_id, body, {
      kind: "lead",
    }).message_id;
  };
  const later = async (minutes: number, look = notices) => {
    // The agent keeps waiting, so it doesn't count as dropped.
    for (let passed = 0; passed < minutes; passed += 1) {
      now += MINUTE;
      service.poll("claude", claude, true);
      service.tick();
    }
    await look.tick();
  };
  beforeEach(async () => {
    now = new Date(2026, 10, 23, 12, 0).getTime();
    warnings = [];
    db = openDatabase(":memory:");
    service = new KonfabService(db, {
      now: () => now,
      waitTimeoutSeconds: 50,
      turnTimeoutMs: 30 * MINUTE,
      maxMessageChars: 1000,
      runHoursFor: () => 24,
    });
    service.ensureAgent("claude", "Claude");
    service.createRoom("private-room", "", ["claude"]);
    claude = service.join("claude", "private-room").session_id;
    writeSettings(home, {
      chat_id: CHAT,
      chat_name: "Lead",
      enabled: false,
      slot: "a",
      bot_id: "1234567890",
      setup_id: "one",
    });
    notices = make();
    await notices.setEnabled(true);
  });
  afterEach(() => db.close());

  it("tells an away lead once about a mention, without its text", async () => {
    mention();
    await later(9);
    expect(telegram.sent()).toEqual([]);
    await later(1);
    await later(30);
    expect(telegram.sent()).toEqual(["Konfab: a room needs you."]);
    expect(telegram.calls[0]?.body.chat_id).toBe(CHAT);
    expect(JSON.stringify(telegram.calls)).not.toContain("secret");
    expect(JSON.stringify(telegram.calls)).not.toContain("private-room");
    expect(JSON.stringify(telegram.calls)).not.toContain("claude");
  });

  describe("with the message text", () => {
    const withText = () => {
      notices = make({ message_text: true });
    };

    it("quotes the message, its agent and room, in one notice", async () => {
      withText();
      mention("@lead the branch   is ready\n\nfor review");
      await later(10);
      await later(1);
      expect(telegram.sent()).toEqual([
        "Konfab · private-room\nClaude: @lead the branch is ready for review",
      ]);
      // Sent once; retries and restarts are as without the text.
      await later(30);
      notices = make({ message_text: true });
      await later(30);
      expect(telegram.sent()).toHaveLength(1);
    });

    it("shows at most three excerpts, newest first, and says the rest aren't sent later", () => {
      const needs = [1, 2, 3, 4, 5].map((n) => ({
        kind: "message" as const,
        id: n,
        room_id: n % 2,
        room: n % 2 ? "odd" : "even",
        created_at: n,
      }));
      const text = noticeText(
        needs,
        (id) => ({ sender: "Claude", body: `number ${id}` }),
        [],
      );
      expect(text).toBe(
        "Konfab · odd\nClaude: number 5\nClaude: number 3\n\nKonfab · even\nClaude: number 4\n\n+2 more, not sent here; open Konfab to read them.",
      );
    });

    it("hides the secrets in use, whatever their form, and is on by default", () => {
      const need = {
        kind: "message" as const,
        id: 1,
        room_id: 1,
        room: "r",
        created_at: 1,
      };
      expect(
        noticeText(
          [need],
          () => ({ sender: "S", body: "key Zq9-secret-Zq9 end" }),
          ["Zq9-secret-Zq9"],
        ),
      ).toBe("Konfab · r\nS: key [hidden] end");
      expect(parseConfig("").phone_notices.message_text).toBe(true);
      expect(
        parseConfig("phone_notices:\n  away_minutes: 5\n").phone_notices
          .message_text,
      ).toBe(true);
    });

    it("hides tokens in every field, of every form and ending, also at the cut", () => {
      const endings = [
        "1234567890:" + "A".repeat(33) + "_",
        "1234567890:" + "B".repeat(33) + "-",
      ];
      const konfab = ["kfb_", "kfl_", "kfs_", "kfw_"].map(
        (p) => `${p}${"c".repeat(20)}`,
      );
      const need = (body: string, room = "r") => ({
        kind: "message" as const,
        id: 1,
        room_id: 1,
        room,
        created_at: 1,
      });
      const text = noticeText(
        [need("x", `room ${konfab[0]}`)],
        () => ({
          sender: `agent ${konfab[1]}`,
          body: `${endings.join(" ")} ${konfab.join(" ")} end`,
        }),
        [],
      );
      for (const secret of [...endings, ...konfab])
        expect(text).not.toContain(secret);
      expect(text).toContain(
        "[hidden] [hidden] [hidden] [hidden] [hidden] [hidden] end",
      );
      // A token right at the 300-character cut: hidden before cutting, so no
      // part of it remains.
      const atCut = noticeText(
        [need("x")],
        () => ({ sender: "S", body: `${"z".repeat(290)} ${endings[0]}` }),
        [],
      );
      expect(atCut).not.toContain("AAAA");
      expect(atCut).toContain("[hidden]");
    });

    it("stays within its budget, names and count included", () => {
      const needs = Array.from({ length: 40 }, (_, n) => ({
        kind: (n % 2 ? "permission" : "event") as "permission" | "event",
        id: n,
        room_id: n,
        room: `room-${"x".repeat(200)}-${n}`,
        created_at: n,
      }));
      needs.push({
        kind: "message" as never,
        id: 99,
        room_id: 99,
        room: "m",
        created_at: 100,
      });
      const text = noticeText(
        needs,
        () => ({ sender: "S".repeat(500), body: "y".repeat(5000) }),
        [],
      );
      expect(text.length).toBeLessThanOrEqual(3500);
      expect(text).toMatch(/\+\d+ more, not sent here/);
      expect(text.startsWith("Konfab · m\n")).toBe(true);
    });

    it("cuts at 300 whole characters, and never splits one", async () => {
      withText();
      const family = "👨‍👩‍👧";
      mention(`@lead ${"a".repeat(290)}${family}${family}tail`);
      await later(11);
      const line = String(telegram.sent()[0]).split("\n")[1]!;
      const quoted = line.slice("Claude: ".length);
      const parts = [
        ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
          quoted,
        ),
      ];
      expect(parts).toHaveLength(300);
      expect(quoted.endsWith("…")).toBe(true);
      expect(quoted).not.toContain("tail");
      // No half of the family emoji.
      expect(quoted.replaceAll(family, "")).not.toMatch(/\u200d/);
    });

    it("hides what looks like a token, and the bot's own", async () => {
      withText();
      mention(
        `@lead ${TOKEN} ghp_${"a".repeat(36)} github_pat_${"b".repeat(40)} kfb_abcdefghijkl done`,
      );
      await later(11);
      const [sent] = telegram.sent();
      expect(sent).toContain("[hidden] [hidden] [hidden] [hidden] done");
      expect(JSON.stringify(telegram.calls)).not.toContain(TOKEN.split(":")[1]);
      expect(sent).not.toMatch(/ghp_|github_pat_|kfb_/);
    });

    it("keeps permission requests and stopped rooms as generic as before", async () => {
      withText();
      service.requestPermission("claude", claude, {
        recipient: "example.com",
        data_description: "secret plans",
        reason: "secret reason",
      });
      await later(11);
      const [sent] = telegram.sent();
      expect(sent).toBe(
        "Konfab · private-room\na permission request is waiting.",
      );
    });

    it("doesn't tell what was read or answered while the token was read", async () => {
      let go!: () => void;
      notices = new TelegramNotices({
        db,
        home,
        options: {
          away_minutes: 10,
          quiet_from: null,
          quiet_to: null,
          room_names: false,
          message_text: true,
          room_every_minutes: 10,
          max_per_day: 20,
        },
        token: () =>
          new Promise<TokenRead>((done) => {
            go = () => done({ state: "found", token: TOKEN } as TokenRead);
          }),
        client: () => client(300),
        now: () => now,
      });
      mention("@lead answer me");
      for (let i = 0; i < 11; i += 1) {
        now += MINUTE;
        service.poll("claude", claude, true);
      }
      const pass = notices.tick();
      await new Promise((done) => setTimeout(done, 10));
      // The lead answers in the room meanwhile.
      service.postUserMessage("private-room", "done");
      go();
      await pass;
      expect(telegram.sent()).toEqual([]);
    });

    it("is off as today, word for word", async () => {
      notices = make({ message_text: false });
      mention("@lead hidden text");
      await later(11);
      expect(telegram.sent()).toEqual(["Konfab: a room needs you."]);
    });
  });

  it("waits while the lead is active, and not for a page that is only left open", async () => {
    mention();
    for (let minute = 0; minute < 30; minute += 1) {
      notices.active();
      await later(1);
    }
    expect(telegram.sent()).toEqual([]);
    // Read by the open page, but nobody was there.
    const id = mention();
    now += 1;
    service.markLeadRead("private-room", [id]);
    await later(11);
    expect(telegram.sent()).toHaveLength(1);
  });

  it("doesn't tell what the lead has already seen or answered", async () => {
    const seen = mention();
    now += MINUTE;
    notices.active();
    service.markLeadRead("private-room", [seen], true);
    await later(20);
    mention();
    service.postUserMessage("private-room", "answered");
    const request = service.requestPermission("claude", claude, {
      recipient: "x@example.com",
      data_description: SECRET,
      reason: "r",
    });
    service.decidePermission(request.id, "denied");
    await later(20);
    expect(telegram.sent()).toEqual([]);
  });

  it("tells about permission requests, dropped agents and refused calls", async () => {
    service.requestPermission("claude", claude, {
      recipient: "x@example.com",
      data_description: SECRET,
      reason: "r",
    });
    await later(11);
    expect(telegram.sent()).toEqual([
      "Konfab: a permission request is waiting.",
    ]);
    service.reportStatus("claude", claude, "blocked", SECRET);
    await later(11);
    expect(telegram.sent().at(-1)).toBe("Konfab: a room has stopped.");
    now += 20 * MINUTE;
    service.tick();
    now += 2 * MINUTE;
    await notices.tick();
    expect(telegram.sent()).toHaveLength(3);
    expect(telegram.sent().at(-1)).toBe("Konfab: a room has stopped.");
    expect(JSON.stringify(telegram.calls)).not.toContain("secret");
  });

  it("makes one notice of things close together, and limits rooms and days", async () => {
    notices = make({ room_every_minutes: 30, max_per_day: 3 });
    mention();
    service.reportStatus("claude", claude, "blocked", SECRET);
    await later(11);
    expect(telegram.sent()).toEqual(["Konfab: your rooms need you."]);
    mention();
    await later(15);
    expect(telegram.sent()).toHaveLength(1);
    await later(15);
    expect(telegram.sent()).toHaveLength(2);
    for (let round = 0; round < 5; round += 1) {
      mention();
      await later(31);
    }
    expect(telegram.sent()).toHaveLength(3);
    // A new day.
    now = new Date(2026, 10, 24, 12, 0).getTime();
    service.poll("claude", claude, true);
    await later(2);
    expect(telegram.sent()).toHaveLength(4);
  });

  it("keeps quiet hours, also over midnight", async () => {
    notices = make({ quiet_from: "22:00", quiet_to: "07:30" });
    now = new Date(2026, 10, 23, 23, 0).getTime();
    mention();
    await later(60 * 8);
    expect(telegram.sent()).toEqual([]);
    await later(31);
    expect(telegram.sent()).toHaveLength(1);
  });

  it("is quiet for paused rooms, breaks, everything paused, and when off", async () => {
    mention();
    service.setAllPaused(true);
    await later(15);
    service.setAllPaused(false);
    service.takeBreak("private-room");
    await later(15);
    expect(telegram.sent()).toEqual([]);
    await notices.setEnabled(false);
    await later(15);
    // What happened while it was off isn't sent afterwards.
    await notices.setEnabled(true);
    await later(15);
    expect(telegram.sent()).toEqual([]);
  });

  it("doesn't repeat or bring up old things after a restart", async () => {
    mention();
    await later(11);
    for (let start = 0; start < 3; start += 1) await later(30, make());
    expect(telegram.sent()).toHaveLength(1);
  });

  it("doesn't send again what may have arrived", async () => {
    telegram.replies.set("sendMessage", { hang: true });
    mention();
    await later(11);
    telegram.replies.delete("sendMessage");
    await later(60);
    expect(telegram.sent()).toHaveLength(1);
    expect(notices.view().problem).toContain("didn't answer in time");
  });

  it("tries again what wasn't delivered, as late as Telegram asks", async () => {
    telegram.replies.set("sendMessage", {
      status: 429,
      body: { ok: false, parameters: { retry_after: 300 } },
    });
    mention();
    await later(11);
    await later(4);
    expect(telegram.sent()).toHaveLength(1);
    telegram.replies.delete("sendMessage");
    await later(2);
    expect(telegram.sent()).toHaveLength(2);
    expect(notices.view().problem).toBeNull();
  });

  it("stops after a refusal until the lead acts, and says so without secrets", async () => {
    telegram.replies.set("sendMessage", { status: 403, body: { ok: false } });
    mention();
    await later(11);
    await later(120);
    expect(telegram.sent()).toHaveLength(1);
    expect(notices.view().problem).toContain("can't write to the chat");
    telegram.replies.delete("sendMessage");
    await notices.setEnabled(true);
    await later(1);
    expect(telegram.sent()).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    const all =
      warnings.join() +
      JSON.stringify(notices.view()) +
      readFileSync(statePath(home), "utf8");
    for (const secret of [TOKEN, String(CHAT), "secret", "private-room"])
      expect(all).not.toContain(secret);
  });

  it("adds room names only when that is turned on", async () => {
    notices = make({ room_names: true });
    mention();
    await later(11);
    expect(telegram.sent()).toEqual([
      "Konfab: a room needs you. (private-room)",
    ]);
  });

  it("sends nothing with another bot's token, also after a restart, until setup is run again", async () => {
    writeSettings(home, {
      ...readSettings(home)!,
      bot_id: "999",
    });
    mention();
    await later(11);
    await later(30, make());
    expect(telegram.calls).toEqual([]);
    expect(warnings[0]).toContain("for another bot");
    writeSettings(home, { ...readSettings(home)!, bot_id: "1234567890" });
    await later(11);
    expect(telegram.sent()).toHaveLength(1);
  });

  it("sends with one setup's chat, bot and token, or nothing, when it changes while the token is read", async () => {
    const one = readSettings(home)!;
    for (const change of [
      () => writeSettings(home, { ...one, setup_id: "two", chat_id: 5 }),
      () => writeSettings(home, { ...one, enabled: false }),
      () => rmSync(settingsPath(home)),
      // Off and on again: what came while it was off isn't sent later.
      () => {
        writeSettings(home, { ...one, enabled: false });
        writeSettings(home, one);
      },
    ]) {
      telegram.calls = [];
      writeSettings(home, one);
      let go!: () => void;
      const held = new Promise<void>((done) => (go = done));
      const slow = new TelegramNotices({
        db,
        home,
        options: {
          away_minutes: 10,
          quiet_from: null,
          quiet_to: null,
          room_names: false,
          message_text: false,
          room_every_minutes: 1,
          max_per_day: 20,
        },
        token: async () => {
          await held;
          return { state: "found", token: TOKEN };
        },
        client: () => client(300),
        now: () => now,
      });
      await slow.tick();
      mention();
      now += 11 * MINUTE;
      const pass = slow.tick();
      await new Promise((done) => setTimeout(done, 10));
      change();
      go();
      await pass;
      expect(telegram.calls).toEqual([]);
    }
  });

  it("doesn't ask macOS again for ten minutes when it doesn't give the token", async () => {
    let reads = 0;
    let state: "unknown" | "found" = "unknown";
    const look = new TelegramNotices({
      db,
      home,
      options: {
        away_minutes: 10,
        quiet_from: null,
        quiet_to: null,
        room_names: false,
        message_text: false,
        room_every_minutes: 10,
        max_per_day: 20,
      },
      token: async () => {
        reads += 1;
        return state === "found"
          ? { state, token: TOKEN }
          : { state: "unknown" };
      },
      client: () => client(300),
      now: () => now,
      warn: (text) => warnings.push(text),
    });
    await look.tick();
    mention();
    await later(11, look);
    await later(5, look);
    expect(reads).toBe(1);
    expect(look.view().problem).toBe("The stored bot token couldn't be read.");
    expect(telegram.calls).toEqual([]);
    state = "found";
    await later(6, look);
    expect(telegram.sent()).toHaveLength(1);
    expect(look.view().problem).toBeNull();
  });

  it("ignores a broken or group setting, and a broken record of what was sent", async () => {
    writeFileSync(statePath(home), "{");
    mention();
    await later(11);
    // Without its record, only new things are sent.
    expect(telegram.sent()).toEqual([]);
    writeFileSync(
      settingsPath(home),
      JSON.stringify({ ...readSettings(home), chat_id: -100 }),
    );
    expect(notices.view().state).toBe("not_set_up");
    mention();
    await later(11);
    expect(telegram.sent()).toEqual([]);
  });

  it("is only for the signed-in lead, and the chat number and token are nowhere else", async () => {
    let logs = "";
    const app = await buildApp({
      service,
      notices,
      port: 18_799,
      logger: true,
      logStream: {
        write: (chunk: string) => (logs += chunk),
      } as never,
    });
    try {
      const host = "127.0.0.1:18799";
      const login = await app.inject({
        url: `/login?code=${service.createLoginCode()}`,
        headers: { host },
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const origin = `http://${host}`;
      const ask = (
        method: "GET" | "PUT" | "POST",
        url: string,
        headers: Record<string, string>,
        payload?: object,
      ) =>
        app.inject({
          method,
          url,
          headers: { host, ...headers },
          ...(payload ? { payload } : {}),
        });
      for (const [method, url, payload] of [
        ["GET", "/api/phone-notices", undefined],
        ["PUT", "/api/phone-notices", { enabled: false }],
        ["POST", "/api/activity", {}],
      ] as const)
        expect(
          (await ask(method, url, { authorization: "Bearer kfb_x" }, payload))
            .statusCode,
        ).toBe(401);
      const view = await ask("GET", "/api/phone-notices", { cookie });
      expect(view.json()).toEqual({
        state: "on",
        chat_name: "Lead",
        away_minutes: 10,
        problem: null,
      });
      mention();
      await later(11);
      expect(
        (
          await ask(
            "PUT",
            "/api/phone-notices",
            { cookie, origin },
            { enabled: false },
          )
        ).json().state,
      ).toBe("off");
      const all = [
        logs,
        view.body,
        JSON.stringify(service.roomState("private-room")),
        JSON.stringify(service.overview()),
        JSON.stringify(service.activity("private-room")),
        service.exportRoom("private-room").markdown,
        db.serialize().toString("latin1"),
      ].join();
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain(String(CHAT));
      expect(
        readdirSync(home)
          .filter((name) => !name.startsWith("config.lock"))
          .sort(),
      ).toEqual(["telegram-state.json", "telegram.json"]);
    } finally {
      await app.close();
    }
  });
});
