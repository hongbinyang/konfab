import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  removeNotices,
  setupTelegram,
  status,
  testNotices,
  tokenOnly,
  turnNotices,
  type SetupDeps,
} from "../../src/cli/telegram-setup.js";
import { TelegramError } from "../../src/server/telegram/client.js";
import {
  beginItem,
  claim,
  commit,
  giveUp,
  isPairing,
  leftOver,
  newPairing,
  noteReady,
  noteUnknown,
  readNotes,
  removeSetup,
  turn,
  WANTED_MS,
} from "../../src/server/telegram/places.js";
import { PhoneSetup } from "../../src/server/telegram/setup.js";
import {
  readSettings,
  settingsPath,
  writeSettings,
  type TelegramSettings,
} from "../../src/server/telegram/store.js";
import { isOwnItem } from "../../src/server/telegram/token.js";
import { FakeKeychain } from "./fake-keychain.js";

// Made up; no test contacts Telegram or uses a Keychain.
const TOKEN = "1234567890:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr";
const BOT = "1234567890";
const CHAT = { id: 987654321, name: "Lead" };
const NOTES = "telegram-notes.json";

let home: string;
let now: number;
let keychain: FakeKeychain;

/** Stands in for Telegram. */
class Bot {
  calls: string[] = [];
  sent: string[] = [];
  messages: { chat: typeof CHAT; text: string; date: number }[] = [];
  total = 0;
  webhook = false;
  fails: Partial<Record<string, Error>> = {};
  hold: Promise<void> | null = null;
  private async call(name: string) {
    this.calls.push(name);
    await this.hold;
    const error = this.fails[name];
    if (error) throw error;
  }
  async botName() {
    await this.call("botName");
    return "konfab_bot";
  }
  async hasWebhook() {
    await this.call("hasWebhook");
    return this.webhook;
  }
  async waitingMessages() {
    await this.call("waitingMessages");
    return { messages: this.messages, total: this.total };
  }
  async send(chat: number, text: string) {
    await this.call("send");
    this.sent.push(`${chat} ${text}`);
  }
}

const base = (overrides: Partial<TelegramSettings> = {}): TelegramSettings => ({
  chat_id: CHAT.id,
  chat_name: CHAT.name,
  enabled: true,
  slot: "env",
  bot_id: BOT,
  setup_id: "one",
  ...overrides,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "konfab-phone-"));
  now = 1_800_000_000_000;
  keychain = new FakeKeychain(TOKEN);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("which stored tokens are whose", () => {
  const ready = async (code = "ABC234", claimed: string | null = null) => {
    const item = await beginItem(home, code, now, claimed);
    await noteReady(home, item, BOT);
    return item;
  };
  const take = (code = "ABC234", setup = "new") =>
    claim(home, code, setup, now);
  const own = (item: string, setup = "new") =>
    base({ slot: "own", item, setup_id: setup });

  it("never makes a name twice, and says whose it is", async () => {
    const items = await Promise.all(
      Array.from({ length: 20 }, () => beginItem(home, "ABC234", now)),
    );
    expect(new Set(items).size).toBe(20);
    expect(items.every(isOwnItem)).toBe(true);
    expect(readNotes(home)).toHaveLength(20);
    expect(statSync(join(home, NOTES)).mode & 0o777).toBe(0o600);
    for (const code of Array.from({ length: 50 }, newPairing))
      expect(isPairing(code)).toBe(true);
    for (const odd of ["abc234", "ABC23", "ABC2345", "ABC23O", 5, null])
      expect(isPairing(odd)).toBe(false);
  });

  it("is claimed once, by its own setup, ready and in time", async () => {
    const item = await beginItem(home, "ABC234", now);
    expect(await take()).toBeNull();
    await noteReady(home, item, BOT);
    expect(await take("XYZ789")).toBeNull();
    const both = await Promise.all([take("ABC234", "a"), take("ABC234", "b")]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await take("ABC234", "c")).toBeNull();
    const late = await ready("LATE22");
    now += WANTED_MS;
    expect(await take("LATE22")).toBeNull();
    expect(leftOver(home, now, null).map((note) => note.item)).toContain(late);
    const unsure = await beginItem(home, "QQQ222", now);
    await noteUnknown(home, unsure);
    expect(await take("QQQ222")).toBeNull();
  });

  it("comes into use only by its own setup's commit, with its own bot", async () => {
    const item = await ready();
    const done = async (next: TelegramSettings, began: string | null = null) =>
      (await commit(home, next, began, now)).done;
    // Not claimed, not its own, not its bot, not the setup it began with.
    expect(await done(own(item))).toBe(false);
    await take();
    expect(await done(own(item, "other"))).toBe(false);
    expect(await done({ ...own(item), bot_id: "999" })).toBe(false);
    expect(await done(own(item), "another")).toBe(false);
    expect(
      await done(own(`${item.slice(0, -1)}${item.endsWith("0") ? 1 : 0}`)),
    ).toBe(false);
    expect(existsSync(settingsPath(home))).toBe(false);
    expect(await done(own(item))).toBe(true);
    expect(readNotes(home)).toEqual([]);
    expect(readSettings(home)).toEqual(own(item));
  });

  it("can't come into use again once it is given up, in whatever order", async () => {
    const item = await ready();
    await take();
    expect(await giveUp(home, item, "new")).toBeNull();
    expect(await giveUp(home, item, null)).toBe(item);
    expect((await commit(home, own(item), null, now)).done).toBe(false);
    // Late news of it changes nothing.
    await noteReady(home, item, BOT);
    expect(readNotes(home)).toMatchObject([{ state: "unused", claimed: null }]);
    expect(await take()).toBeNull();
    // The one in use is never given up, nor is anything while it isn't known.
    const used = await ready("USED22");
    await take("USED22", "used");
    await commit(home, own(used, "used"), null, now);
    expect(await giveUp(home, used, null)).toBeNull();
    writeFileSync(settingsPath(home), "{");
    expect(await giveUp(home, item, null)).toBeNull();
    expect(await giveUp(home, "login", null)).toBeNull();
  });

  it("names what is replaced or removed, and gives back only its own item", async () => {
    writeSettings(home, base({ slot: "a" }));
    const first = await ready("ONE222");
    await take("ONE222", "first");
    expect(await commit(home, own(first, "first"), "one", now)).toEqual({
      done: true,
      old: null,
    });
    expect(leftOver(home, now, null)).toMatchObject([
      { item: "konfab-telegram-token-a", state: "unused" },
    ]);
    const second = await ready("TWO222");
    await take("TWO222", "second");
    expect(await commit(home, own(second, "second"), "first", now)).toEqual({
      done: true,
      old: first,
    });
    expect(await removeSetup(home, now)).toEqual({
      removed: true,
      item: second,
    });
    expect(readSettings(home)).toBeNull();
    expect(
      leftOver(home, now, null)
        .map((note) => note.item)
        .sort(),
    ).toEqual(["konfab-telegram-token-a", first, second].sort());
    expect(await removeSetup(home, now)).toEqual({
      removed: false,
      item: null,
    });
  });

  it.each(["notes", "settings"] as const)(
    "is in use or has a note after a crash after writing the %s",
    async (where) => {
      const old = await ready("OLD222");
      await take("OLD222", "old");
      await commit(home, own(old, "old"), null, now);
      const item = await ready();
      await take();
      await expect(
        commit(home, own(item), "old", now, (what) => {
          if (what === where) throw new Error("as if it died");
        }),
      ).rejects.toThrow("as if it died");
      const used = readSettings(home)!.item!;
      expect(used).toBe(where === "notes" ? old : item);
      expect([used, ...readNotes(home).map((note) => note.item)]).toEqual(
        expect.arrayContaining([old, item]),
      );
      const left = leftOver(home, now + WANTED_MS, null);
      expect(left.map((note) => note.item)).toEqual([
        used === item ? old : item,
      ]);
      expect(await giveUp(home, used, null)).toBeNull();
      expect(await giveUp(home, left[0]!.item, null)).toBe(left[0]!.item);
    },
  );

  it("never deletes the one in use, over many orders of everything", async () => {
    let seed = 7;
    const pick = (n: number) =>
      (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    let setups = 0;
    const claimed: { item: string; setup: string; began: string | null }[] = [];
    for (let round = 0; round < 250; round += 1) {
      const what = pick(6);
      if (what === 0) {
        const code = newPairing();
        const item = await ready(code);
        keychain.items.set(item, TOKEN);
        const setup = `setup-${(setups += 1)}`;
        if (await claim(home, code, setup, now))
          claimed.push({
            item,
            setup,
            began: readSettings(home)?.setup_id ?? null,
          });
      } else if (what <= 2 && claimed.length) {
        const [one] = claimed.splice(pick(claimed.length), 1);
        const { old } = await commit(
          home,
          own(one!.item, one!.setup),
          // Mostly the one that is there.
          pick(4) ? (readSettings(home)?.setup_id ?? null) : one!.began,
          now,
        );
        if (old && (await giveUp(home, old, null))) await keychain.remove(old);
      } else if (what === 3) {
        const { item } = await removeSetup(home, now);
        if (item && (await giveUp(home, item, null)))
          await keychain.remove(item);
      } else if (what === 4) {
        await turn(home, pick(2) === 0);
      } else {
        const notes = readNotes(home);
        const note = notes[pick(notes.length || 1)];
        const under = claimed[0]?.setup ?? null;
        if (note && (await giveUp(home, note.item, under)))
          await keychain.remove(note.item);
      }
      if (pick(10) === 0) now += WANTED_MS;
      const used = readSettings(home)?.item;
      if (used) expect(keychain.items.has(used), `round ${round}`).toBe(true);
    }
    expect(keychain.removed.length).toBeGreaterThan(10);
  }, 20_000);

  it("is of one folder only", async () => {
    const item = await ready();
    const other = mkdtempSync(join(tmpdir(), "konfab-phone-"));
    try {
      expect(await claim(other, "ABC234", "x", now)).toBeNull();
      expect(await giveUp(other, item, null)).toBeNull();
      expect(readNotes(other)).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it.each(["{", "[]", '{"notes":[{"item":"login","at":1}]}', '{"notes":5}'])(
    "takes nothing from a broken note (%#)",
    (text) => {
      writeFileSync(join(home, NOTES), text);
      expect(readNotes(home)).toEqual([]);
    },
  );

  it("sends nothing with a place it doesn't know, as from a later version", () => {
    for (const change of [
      { slot: "later" },
      { slot: "own" },
      { slot: "own", item: "konfab-telegram-token-a" },
      { slot: "a", item: `konfab-telegram-token-${"0".repeat(32)}` },
    ]) {
      writeFileSync(
        settingsPath(home),
        JSON.stringify({ ...base(), ...change }),
      );
      expect(readSettings(home)).toBeNull();
    }
  });
});

describe("setting up in the page", () => {
  let bot: Bot;
  let setup: PhoneSetup;
  let sleeping: (() => void)[];
  const CODE = "KONFAB-ABCDE-23456";
  const make = () =>
    new PhoneSetup({
      home,
      keychain: keychain as never,
      client: () => bot,
      changed: () => undefined,
      now: () => now,
      sleep: (ms) =>
        new Promise((done) =>
          sleeping.push(() => {
            now += ms;
            done();
          }),
        ),
      code: () => CODE,
    });
  const settle = async () => {
    for (let i = 0; i < 30; i += 1)
      await new Promise((done) => setImmediate(done));
  };
  /** The next look at the waiting messages. */
  const look = async () => {
    sleeping.shift()?.();
    await settle();
  };
  const message = (change: object = {}) => ({
    chat: CHAT,
    text: CODE,
    date: Math.floor(now / 1000) + 1,
    ...change,
  });
  const view = () => setup.view()!;
  /** As the lead does it in a terminal. */
  const terminal = (code: string, deps: Partial<SetupDeps> = {}) =>
    tokenOnly(cli(deps), code);
  const cli = (change: Partial<SetupDeps> = {}): SetupDeps => ({
    home,
    say: (line) => void said.push(line),
    ask: async () => "y",
    keychain,
    client: () => bot,
    sleep: async () => undefined,
    now: () => now,
    code: () => CODE,
    ...change,
  });
  let said: string[];
  const codeOf = (command: string | null) =>
    /--token-only ([A-Z0-9]{6})$/.exec(command ?? "")![1]!;
  const toBot = async () => {
    const started = await setup.start("terminal");
    await terminal(codeOf(started.command));
    view();
    await settle();
    expect(view()).toMatchObject({ step: "bot", bot: "konfab_bot" });
    return view().id;
  };
  const toChat = async () => {
    const id = await toBot();
    await setup.code(id);
    bot.messages = [message()];
    await look();
    expect(view()).toMatchObject({ step: "chat", chat_name: "Lead" });
    return id;
  };
  const toFinish = async () => {
    const id = await toChat();
    await setup.sendTest(id);
    setup.confirm(id, true);
    expect(view()).toMatchObject({ step: "finish", arrived: true });
    return id;
  };

  beforeEach(() => {
    bot = new Bot();
    sleeping = [];
    said = [];
    setup = make();
  });

  it("goes from the terminal's token to a working setup, each step by the lead", async () => {
    expect(setup.ways()).toEqual(["terminal"]);
    const started = await setup.start("terminal");
    expect(started).toMatchObject({ step: "token", way: "terminal" });
    expect(bot.calls).toEqual([]);
    await terminal(codeOf(started.command));
    expect(said.at(-1)).toContain("Go on in the page");
    view();
    await settle();
    expect(bot.calls).toEqual(["botName", "hasWebhook"]);
    const { id } = view();
    const shown = await setup.code(id);
    expect(shown).toMatchObject({
      step: "code",
      code: CODE,
      seconds_left: 300,
    });
    await look();
    expect(view().step).toBe("code");
    bot.messages = [
      message({ text: `${CODE} x` }),
      message({ date: 5 }),
      message(),
    ];
    await look();
    expect(view()).toMatchObject({ step: "chat", code: null });
    expect(bot.sent).toEqual([]);
    await setup.sendTest(id);
    expect(bot.sent).toEqual([`${CHAT.id} Konfab: test`]);
    expect(view()).toMatchObject({ step: "test", arrived: null });
    setup.confirm(id, true);
    expect(readSettings(home)).toBeNull();
    await setup.finish(id, true);
    expect(setup.view()).toBeNull();
    const done = readSettings(home)!;
    expect(done).toMatchObject({
      chat_id: CHAT.id,
      enabled: true,
      slot: "own",
      bot_id: BOT,
    });
    expect([...keychain.items.keys()]).toEqual([done.item]);
    expect(readNotes(home)).toEqual([]);
    expect(setup.leftOvers()).toEqual([]);
  });

  it("never shows the token or the chat's number", async () => {
    const seen: unknown[] = [];
    const real = setup.view.bind(setup);
    vi.spyOn(setup, "view").mockImplementation(() => {
      const value = real();
      seen.push(value);
      return value;
    });
    const id = await toFinish();
    await setup.finish(id, false);
    const all = JSON.stringify([seen, said, setup.leftOvers()]);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(TOKEN.split(":")[1]);
    expect(all).not.toContain(String(CHAT.id));
    for (const name of readdirSync(home))
      expect(readFileSync(join(home, name)).toString("latin1")).not.toContain(
        TOKEN,
      );
  });

  it("uses the environment's token where there is one, and stores nothing", async () => {
    keychain.fromEnvironment = true;
    expect(setup.ways()).toEqual(["env"]);
    const { id, step } = await setup.start("env");
    expect(step).toBe("bot");
    await setup.code(id);
    bot.messages = [message()];
    await look();
    setup.confirm(id, true);
    expect(view()).toMatchObject({ step: "finish", arrived: null });
    await setup.finish(id, true);
    expect(readSettings(home)).toMatchObject({ slot: "env" });
    expect(keychain.items.size).toBe(0);
    await expect(setup.start("terminal")).rejects.toThrow(/isn't there/);
  });

  it("has no way on a system without a Keychain or a token", async () => {
    keychain.usable = false;
    expect(setup.ways()).toEqual([]);
    await expect(setup.start("terminal")).rejects.toThrow();
    expect(setup.view()).toBeNull();
  });

  it("is one at a time, and a step of another tab or of an ended one is refused", async () => {
    const id = await toBot();
    await expect(setup.start("terminal")).rejects.toThrow(/under way/);
    await expect(
      setup.code("00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow(/has ended/);
    setup.cancel(id);
    for (const step of [
      () => setup.code(id),
      () => setup.sendTest(id),
      () => setup.finish(id, true),
      () => setup.again(id),
    ])
      await expect(step()).rejects.toThrow(/has ended/);
    expect(() => setup.confirm(id, true)).toThrow(/has ended/);
    expect(() => setup.cancel(id)).toThrow(/has ended/);
    const next = await setup.start("terminal");
    expect(next.id).not.toBe(id);
  });

  it("refuses steps out of order", async () => {
    const id = await toBot();
    await expect(setup.sendTest(id)).rejects.toThrow(/next step/);
    expect(() => setup.confirm(id, true)).toThrow(/next step/);
    await expect(setup.finish(id, true)).rejects.toThrow(/next step/);
    await expect(setup.again(id)).rejects.toThrow(/next step/);
    expect(readSettings(home)).toBeNull();
    expect(bot.sent).toEqual([]);
  });

  it("takes only the token that was stored for its own code", async () => {
    const started = await setup.start("terminal");
    await terminal(newPairing());
    view();
    await settle();
    expect(view()).toMatchObject({ step: "token", problem: null });
    // The second setup doesn't take the first one's either.
    setup.cancel(started.id);
    await terminal(codeOf(started.command));
    await setup.start("terminal");
    view();
    await settle();
    expect(view().step).toBe("token");
    expect(bot.calls).toEqual([]);
    now += WANTED_MS;
    expect(setup.leftOvers()).toHaveLength(2);
    expect(keychain.reads.filter((item) => isOwnItem(item))).toHaveLength(2);
  });

  it("stays at its step when macOS doesn't give the token, and tries again by a click", async () => {
    const started = await setup.start("terminal");
    await terminal(codeOf(started.command));
    keychain.unknown = true;
    view();
    await settle();
    expect(view()).toMatchObject({
      step: "token",
      again: true,
      command: null,
      problem: "macOS didn't give the bot token.",
    });
    const reads = keychain.reads.length;
    for (let i = 0; i < 5; i += 1) view();
    await settle();
    // Not by itself: it could open a window each time.
    expect(keychain.reads).toHaveLength(reads);
    keychain.unknown = false;
    await setup.again(started.id);
    expect(view().step).toBe("bot");
  });

  it("doesn't use a token of another bot than was noted, or one that is gone", async () => {
    for (const spoil of [
      (item: string) =>
        keychain.items.set(item, TOKEN.replace(BOT, "9999999999")),
      (item: string) => keychain.items.delete(item),
    ]) {
      const started = await setup.start("terminal");
      await terminal(codeOf(started.command));
      spoil(readNotes(home).at(-1)!.item);
      view();
      await settle();
      expect(view()).toMatchObject({ step: "token", again: true });
      expect(view().problem).toContain("isn't the one for this setup");
      expect(bot.calls).toEqual([]);
      setup.cancel(started.id);
    }
  });

  it.each([
    ["botName", new TelegramError("Telegram refused the bot token.", "never")],
    ["hasWebhook", new TelegramError("Telegram can't be reached.", "no")],
    ["botName", new Error(`raw ${TOKEN}`)],
  ])("says what went wrong in plain words (%s)", async (name, error) => {
    bot.fails[name] = error;
    const started = await setup.start("terminal");
    await terminal(codeOf(started.command));
    view();
    await settle();
    expect(view()).toMatchObject({ step: "token", again: true });
    expect(view().problem).toBe(
      error instanceof TelegramError ? error.message : "Setup had a problem.",
    );
  });

  it("leaves a bot alone that something else uses, or that isn't new", async () => {
    bot.webhook = true;
    const started = await setup.start("terminal");
    await terminal(codeOf(started.command));
    view();
    await settle();
    expect(view().problem).toContain("webhook");
    bot.webhook = false;
    await setup.again(started.id);
    bot.total = 60;
    await setup.code(started.id);
    expect(view()).toMatchObject({ step: "bot", code: null });
    expect(view().problem).toContain("isn't a new one");
  });

  it("ends the code after five minutes, and a new one makes the old one void", async () => {
    const id = await toBot();
    await setup.code(id);
    for (let i = 0; i < 101; i += 1) await look();
    expect(view()).toMatchObject({
      step: "bot",
      problem: "The code didn't arrive in time.",
    });
    await setup.code(id);
    await expect(setup.code(id)).rejects.toThrow(/next step/);
    bot.fails.waitingMessages = new TelegramError("again", "maybe");
    await look();
    expect(view().step).toBe("code");
    delete bot.fails.waitingMessages;
    bot.fails.waitingMessages = new TelegramError("", "never", undefined, true);
    await look();
    expect(view()).toMatchObject({ step: "bot" });
    expect(view().problem).toContain("Something else is reading this bot");
  });

  it("doesn't go on after it is cancelled in the middle of anything", async () => {
    // While Telegram is asked about the bot.
    let go!: () => void;
    bot.hold = new Promise((done) => (go = done));
    const first = await setup.start("terminal");
    await terminal(codeOf(first.command));
    view();
    await settle();
    expect(view().busy).toBe(true);
    setup.cancel(first.id);
    go();
    await settle();
    expect(setup.view()).toBeNull();
    bot.hold = null;
    // While it waits for the code.
    const id = await toBot();
    await setup.code(id);
    setup.cancel(id);
    bot.messages = [message()];
    await look();
    expect(setup.view()).toBeNull();
    // While a test is sent, and while it is saved.
    bot.messages = [];
    const third = await toChat();
    bot.hold = new Promise((done) => (go = done));
    const sending = setup.sendTest(third).catch((error: Error) => error);
    setup.cancel(third);
    go();
    bot.hold = null;
    await sending;
    expect(setup.view()).toBeNull();
    expect(readSettings(home)).toBeNull();
    const fourth = await toFinish();
    const saving = setup.finish(fourth, true).catch((error: Error) => error);
    setup.cancel(fourth);
    await saving;
    // Either it was saved or it wasn't, and nothing is lost.
    const used = readSettings(home)?.item;
    expect(
      [...keychain.items.keys()].every(
        (item) =>
          item === used || readNotes(home).some((note) => note.item === item),
      ),
    ).toBe(true);
  });

  it("ends by itself after its time, and what it left is shown, not deleted", async () => {
    await toChat();
    now += WANTED_MS + 6 * 60_000;
    expect(setup.view()).toBeNull();
    const [left] = setup.leftOvers();
    expect(left).toMatchObject({ unsure: false, old: false });
    expect(keychain.removed).toEqual([]);
    await setup.removeLeftOver(left!.item, false);
    expect(keychain.items.size).toBe(0);
    expect(setup.leftOvers()).toEqual([]);
    await expect(setup.removeLeftOver(left!.item, false)).rejects.toThrow(
      /any more/,
    );
  });

  it("leaves after a restart only a note, whatever was under way", async () => {
    await toFinish();
    setup = make();
    expect(setup.view()).toBeNull();
    expect(setup.leftOvers()).toHaveLength(1);
    expect(keychain.removed).toEqual([]);
    expect(keychain.reads.length).toBeGreaterThan(0);
    const reads = keychain.reads.length;
    setup.leftOvers();
    setup.view();
    await settle();
    expect(keychain.reads).toHaveLength(reads);
  });

  it("keeps the earlier setup until the last step, and then removes only its own token", async () => {
    await setup.finish(await toFinish(), true);
    const first = readSettings(home)!;
    bot.messages = [];
    const id = await toFinish();
    expect(readSettings(home)).toEqual(first);
    await setup.finish(id, false);
    const second = readSettings(home)!;
    expect(second).toMatchObject({ enabled: false });
    expect(keychain.removed).toEqual([first.item]);
    expect([...keychain.items.keys()]).toEqual([second.item]);
  });

  it("doesn't undo what was changed while it ran: in the terminal, removed, or its token given up", async () => {
    const terminalSetup = async () => {
      bot.messages = [message()];
      expect(
        await setupTelegram(
          cli({
            ask: async () => {
              bot.messages = [message()];
              return "y";
            },
            sleep: async () => undefined,
          }),
        ),
      ).toBe(true);
    };
    await terminalSetup();
    for (const change of [
      terminalSetup,
      async () => void (await removeSetup(home, now)),
    ]) {
      bot.messages = [];
      const id = await toFinish();
      await change();
      const then = readSettings(home);
      await expect(setup.finish(id, true)).rejects.toThrow(/changed meanwhile/);
      expect(readSettings(home)).toEqual(then);
      setup.cancel(id);
    }
    bot.messages = [];
    const id = await toFinish();
    const item = readNotes(home)
      .filter((note) => note.claimed)
      .at(-1)!.item;
    // Another process of this folder, which doesn't know of this setup.
    expect(await giveUp(home, item, null)).toBe(item);
    await expect(setup.finish(id, true)).rejects.toThrow(/changed meanwhile/);
    expect(readSettings(home)).toBeNull();
  });

  it("turns off and removes first, and then deletes only its own token", async () => {
    await setup.finish(await toFinish(), true);
    const { item } = readSettings(home)!;
    keychain.keeps = true;
    await setup.remove();
    expect(readSettings(home)).toBeNull();
    expect(setup.leftOvers()).toMatchObject([{ item }]);
    await expect(setup.removeLeftOver(item!, false)).rejects.toThrow(item);
    keychain.keeps = false;
    await setup.removeLeftOver(item!, false);
    expect(setup.leftOvers()).toEqual([]);
    // One of an earlier version stays, and needs its own question.
    writeSettings(home, base({ slot: "b" }));
    keychain.items.set("konfab-telegram-token-b", TOKEN);
    await setup.remove();
    expect(keychain.items.has("konfab-telegram-token-b")).toBe(true);
    expect(setup.leftOvers()).toMatchObject([{ old: true }]);
    await expect(
      setup.removeLeftOver("konfab-telegram-token-b", false),
    ).rejects.toThrow(/Another Konfab folder/);
    await setup.removeLeftOver("konfab-telegram-token-b", true);
    expect(keychain.items.size).toBe(0);
  });

  it("deletes once for two clicks", async () => {
    await toBot();
    now += WANTED_MS;
    const { item } = setup.leftOvers()[0]!;
    let go!: () => void;
    keychain.hold = new Promise((done) => (go = done));
    const clicks = [
      setup.removeLeftOver(item, false),
      setup.removeLeftOver(item, false),
    ].map((click) => click.catch((error: Error) => error.message));
    await settle();
    go();
    const results = await Promise.all(clicks);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(keychain.removed).toEqual([item]);
  });

  it("sends a test with one setup's chat and token, or nothing", async () => {
    await expect(setup.test()).rejects.toThrow(/aren't set up/);
    await setup.finish(await toFinish(), true);
    bot.sent = [];
    await setup.test();
    expect(bot.sent).toEqual([`${CHAT.id} Konfab: test`]);
    // Replaced while the token is read.
    let go!: () => void;
    keychain.hold = new Promise((done) => (go = done));
    const late = setup.test().catch((error: Error) => error.message);
    await settle();
    writeSettings(home, base({ setup_id: "another", chat_id: 5 }));
    go();
    expect(await late).toContain("changed meanwhile");
    expect(bot.sent).toHaveLength(1);
    keychain.hold = null;
    // Another bot's token, and then too many.
    writeSettings(home, base({ bot_id: "9" }));
    keychain.fromEnvironment = true;
    await expect(setup.test()).rejects.toThrow(/another bot/);
    keychain.unknown = true;
    await expect(setup.test()).rejects.toThrow(/didn't give/);
    await expect(setup.test()).rejects.toThrow();
    await expect(setup.test()).rejects.toThrow(/enough tests/);
    now += 3_600_000;
    keychain.unknown = false;
    writeSettings(home, base());
    await setup.test();
    expect(bot.sent).toHaveLength(2);
  });

  it("sends at most five tests in a setup, and goes back when none came", async () => {
    const id = await toChat();
    for (let i = 0; i < 5; i += 1) await setup.sendTest(id);
    await expect(setup.sendTest(id)).rejects.toThrow(/enough tests/);
    setup.confirm(id, false);
    expect(view()).toMatchObject({ step: "bot", chat_name: null });
    expect(view().problem).toContain("send a new code");
    expect(readSettings(home)).toBeNull();
  });

  describe("on the command line", () => {
    it("stores nothing without the page's code, or where there is no Keychain", async () => {
      for (const code of [undefined, "abc", "ABC23O"])
        expect(await tokenOnly(cli(), code)).toBe(false);
      keychain.usable = false;
      expect(await tokenOnly(cli(), "ABC234")).toBe(false);
      keychain.usable = true;
      keychain.fromEnvironment = true;
      expect(await tokenOnly(cli(), "ABC234")).toBe(false);
      expect(readNotes(home)).toEqual([]);
      expect(keychain.items.size).toBe(0);
    });

    it.each([
      ["refused", () => (keychain.refuses = true), []],
      ["broken", () => (keychain.breaks = true), []],
      ["unclear", () => (keychain.unknown = true), ["unknown"]],
    ])(
      "notes what is known when storing is %s",
      async (_what, spoil, states) => {
        spoil();
        expect(await tokenOnly(cli(), "ABC234")).toBe(false);
        expect(readNotes(home).map((note) => note.state)).toEqual(states);
        expect(keychain.removed).toEqual([]);
      },
    );

    it("has noted the item before anything is stored, also if it dies then", async () => {
      vi.spyOn(keychain, "storeByHand").mockImplementation((item) => {
        expect(readNotes(home)).toMatchObject([{ item, state: "storing" }]);
        keychain.items.set(item, TOKEN);
        throw new Error("as if it died");
      });
      vi.spyOn(keychain, "read").mockRejectedValue(new Error("dead"));
      await tokenOnly(cli(), "ABC234");
      vi.restoreAllMocks();
      const item = [...keychain.items.keys()][0]!;
      expect(leftOver(home, now, null)).toMatchObject([{ item }]);
      // One that really died left "storing".
      writeFileSync(
        join(home, NOTES),
        JSON.stringify({
          notes: [{ ...readNotes(home)[0], state: "storing" }],
        }),
      );
      expect(await claim(home, "ABC234", "x", now)).toBeNull();
      expect(leftOver(home, now, null)).toEqual([]);
      expect(leftOver(home, now + WANTED_MS, null)).toMatchObject([{ item }]);
    });

    it("says how it is, turns it on and off, and forgets what came while it was off", async () => {
      status(cli());
      expect(said).toEqual(["Phone notices: not set up."]);
      expect(await turnNotices(cli(), true)).toBe(false);
      writeSettings(home, base({ enabled: false }));
      writeFileSync(
        join(home, "telegram-state.json"),
        JSON.stringify({
          setup_id: "one",
          rooms: {
            1: { message: 1, permission: 1, event: 1, report: 1, sent_at: 1 },
          },
          baseline: { message: 1, permission: 1, event: 1, report: 1 },
          day: "2026-11-25",
          day_count: 3,
        }),
      );
      expect(await turnNotices(cli(), true)).toBe(true);
      expect(readSettings(home)?.enabled).toBe(true);
      expect(
        JSON.parse(readFileSync(join(home, "telegram-state.json"), "utf8")),
      ).toMatchObject({ rooms: {}, baseline: null, day_count: 3 });
      said = [];
      status(cli());
      expect(said[0]).toContain("on, to Lead");
      expect(said[0]).not.toContain(String(CHAT.id));
    });

    it("sends a test only after a yes", async () => {
      expect(await testNotices(cli())).toBe(false);
      writeSettings(home, base());
      keychain.fromEnvironment = true;
      expect(await testNotices(cli({ ask: async () => "" }))).toBe(false);
      expect(bot.calls).toEqual([]);
      expect(await testNotices(cli())).toBe(true);
      expect(bot.sent).toEqual([`${CHAT.id} Konfab: test`]);
      bot.fails.send = new TelegramError("The bot can't write.", "never");
      expect(await testNotices(cli())).toBe(false);
      expect(said.at(-1)).toBe("The bot can't write.");
    });

    it("removes its own token, and one of an earlier version only after a yes", async () => {
      await setup.finish(await toFinish(), true);
      const { item } = readSettings(home)!;
      await removeNotices(cli());
      expect(keychain.removed).toEqual([item]);
      for (const answer of ["", "y"]) {
        writeSettings(home, base({ slot: "a" }));
        keychain.items.set("konfab-telegram-token-a", TOKEN);
        await removeNotices(cli({ ask: async () => answer }));
        expect(readSettings(home)).toBeNull();
        expect(keychain.items.has("konfab-telegram-token-a")).toBe(
          answer !== "y",
        );
      }
    });
  });
});
