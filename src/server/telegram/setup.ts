import { randomUUID } from "node:crypto";
import { KonfabError } from "../domain/errors.js";
import { TOKEN_PATTERN, type Chat, type TelegramClient } from "./client.js";
import {
  beginItem,
  claim,
  commit,
  dropNote,
  giveUp,
  leftOver,
  newPairing,
  newSetupId,
  noteReady,
  noteUnknown,
  readNotes,
  removeSetup,
  WANTED_MS,
} from "./places.js";
import {
  chatFromCode,
  checkBot,
  CODE_MINUTES,
  newCode,
  problemText,
  SetupProblem,
} from "./steps.js";
import { readSettings } from "./store.js";
import {
  botId,
  isOldItem,
  isOwnItem,
  keptIn,
  type Keychain,
  type TokenRead,
} from "./token.js";

/**
 * Setting up phone notices from the page, one at a time, and only in memory:
 * until the last step nothing of the earlier setup is touched. A pasted
 * token comes from the page once and never goes back to it.
 */
export type Way = "paste" | "terminal" | "env";
type Client = Pick<
  TelegramClient,
  "botName" | "hasWebhook" | "waitingMessages" | "send"
>;

export type SetupView = {
  id: string;
  way: Way;
  step: "token" | "bot" | "code" | "chat" | "test" | "finish";
  /** What to run in a terminal, for that way. */
  command: string | null;
  busy: boolean;
  /** Its token is there, but couldn't be read or used; by the lead's click. */
  again: boolean;
  bot: string | null;
  code: string | null;
  seconds_left: number | null;
  chat_name: string | null;
  arrived: boolean | null;
  problem: string | null;
};

export type LeftOver = {
  item: string;
  at: number;
  /** Whether something is surely stored isn't known. */
  unsure: boolean;
  /** Of an earlier version; another Konfab folder may use it. */
  old: boolean;
};

type Current = {
  id: string;
  setup: string;
  /** The setup it began with. */
  began: string | null;
  way: Way;
  pairing: string | null;
  step: SetupView["step"];
  busy: boolean;
  token: string | null;
  item: string | null;
  bot: string | null;
  code: string | null;
  codeUntil: number;
  chat: Chat | null;
  arrived: boolean | null;
  tests: number;
  problem: string | null;
  until: number;
  ended: boolean;
};

const TESTS = 5;
const TESTS_AN_HOUR = 5;
const refuse = (code: string, message: string): never => {
  throw new KonfabError(code, 409, message);
};

export class PhoneSetup {
  private current: Current | null = null;
  private tests: number[] = [];
  private deleting = new Set<string>();

  constructor(
    private readonly deps: {
      home: string;
      keychain: Keychain;
      client: (token: string) => Client;
      changed: () => void;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      code?: () => string;
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return (
      this.deps.sleep ??
      ((time: number) => new Promise((done) => setTimeout(done, time).unref()))
    )(ms);
  }

  /** The one that is under way and still has time. */
  private live(): Current | null {
    if (this.current && this.now() >= this.current.until) this.end();
    return this.current;
  }

  private end(): void {
    if (!this.current) return;
    this.current.ended = true;
    this.current.token = null;
    this.current = null;
    this.deps.changed();
  }

  private named(id: string): Current {
    const current = this.live();
    if (!current || current.id !== id)
      return refuse(
        "setup_ended",
        "This setup has ended, or another one was started",
      );
    return current;
  }

  ways(): Way[] {
    return this.deps.keychain.fromEnvironment
      ? ["env"]
      : this.deps.keychain.usable
        ? ["paste", "terminal"]
        : [];
  }

  /** Where a token is kept on this computer. */
  kept() {
    return this.deps.keychain.kept;
  }

  view(): SetupView | null {
    const current = this.live();
    if (!current) return null;
    if (current.step === "token" && current.way === "terminal" && !current.busy)
      void this.look(current);
    return {
      id: current.id,
      way: current.way,
      step: current.step,
      command:
        current.way === "terminal" && current.step === "token" && !current.item
          ? `npm run setup -- --telegram --token-only ${current.pairing}`
          : null,
      busy: current.busy,
      again: current.step === "token" && current.item !== null && !current.busy,
      bot: current.bot,
      code: current.step === "code" ? current.code : null,
      seconds_left:
        current.step === "code"
          ? Math.max(0, Math.round((current.codeUntil - this.now()) / 1000))
          : null,
      chat_name: current.chat?.name ?? null,
      arrived: current.arrived,
      problem: current.problem,
    };
  }

  leftOvers(): LeftOver[] {
    return leftOver(this.deps.home, this.now(), this.live()?.setup ?? null).map(
      ({ item, at, state }) => ({
        item,
        at,
        unsure: state === "unknown" || state === "storing",
        old: isOldItem(item),
      }),
    );
  }

  /** The lead agreed that Konfab contacts Telegram. */
  async start(way: Way): Promise<SetupView> {
    if (this.live())
      return refuse("setup_under_way", "A setup is under way already");
    if (!this.ways().includes(way))
      return refuse("setup_way", "That way isn't there on this computer");
    const current: Current = {
      id: randomUUID(),
      setup: newSetupId(),
      began: readSettings(this.deps.home)?.setup_id ?? null,
      way,
      pairing: way === "terminal" ? newPairing() : null,
      step: "token",
      busy: false,
      token: null,
      item: null,
      bot: null,
      code: null,
      codeUntil: 0,
      chat: null,
      arrived: null,
      tests: 0,
      problem: null,
      until: this.now() + WANTED_MS,
      ended: false,
    };
    this.current = current;
    if (way === "env")
      await this.step(current, async () => {
        const read = await this.deps.keychain.read({ slot: "env" });
        if (read.state !== "found")
          throw new SetupProblem(
            "KONFAB_TELEGRAM_TOKEN isn't a bot token. Set it for the server and start Konfab again.",
          );
        await this.take(current, read.token);
      });
    this.deps.changed();
    return this.view()!;
  }

  /** One thing at a time; a late answer of an ended setup changes nothing. */
  private async step(
    current: Current,
    action: () => Promise<void>,
  ): Promise<void> {
    if (current.busy) return refuse("setup_busy", "Wait a moment");
    current.busy = true;
    current.problem = null;
    try {
      await action();
    } catch (error) {
      if (error instanceof KonfabError) throw error;
      current.problem = problemText(error);
    } finally {
      current.busy = false;
      if (!current.ended) this.deps.changed();
    }
  }

  /** Neither ended by the lead nor by time, as of now. */
  private goesOn(current: Current): boolean {
    return !current.ended && this.live() === current;
  }

  private still(current: Current): void {
    if (!this.goesOn(current)) throw new SetupProblem("Setup was ended.");
  }

  private async take(current: Current, token: string): Promise<void> {
    this.still(current);
    const bot = await checkBot(this.deps.client(token));
    this.still(current);
    current.token = token;
    current.bot = bot;
    current.step = "bot";
  }

  /** Whether the terminal has stored a token for this very setup. */
  private async look(current: Current): Promise<void> {
    if (
      !readNotes(this.deps.home).some(
        (note) => note.code === current.pairing && note.state === "ready",
      )
    )
      return;
    await this.step(current, async () => {
      const note = await claim(
        this.deps.home,
        current.pairing!,
        current.setup,
        this.now(),
        () => this.goesOn(current),
      );
      if (!note) return;
      current.item = note.item;
      // Once by itself; again only by the lead's click.
      await this.readItem(current);
    }).catch(() => undefined);
  }

  private async readItem(current: Current): Promise<void> {
    const item = current.item!;
    current.pairing = null;
    const read = await this.deps.keychain.read({ slot: "own", item });
    this.still(current);
    const note = readNotes(this.deps.home).find((one) => one.item === item);
    if (
      read.state !== "found" ||
      note?.claimed !== current.setup ||
      note.bot_id !== botId(read.token)
    )
      throw new SetupProblem(
        read.state === "unknown"
          ? "The stored bot token couldn't be read."
          : "The stored bot token isn't there, or isn't the one for this setup. Start again.",
      );
    await this.take(current, read.token);
  }

  /**
   * The token from the page. Kept only in memory until the last step, so
   * that cancel, a closed page or a restart leave nothing stored.
   */
  async paste(id: string, token: string): Promise<SetupView> {
    const current = this.named(id);
    if (current.way !== "paste" || current.step !== "token")
      return refuse("setup_step", "That isn't the next step");
    if (!TOKEN_PATTERN.test(token.trim()))
      return refuse("not_a_token", "That isn't a bot token");
    await this.step(current, () => this.take(current, token.trim()));
    return this.view()!;
  }

  /**
   * At the last step, the pasted token goes into a new item. Only reading it
   * back says whether it is there.
   */
  private async storePasted(current: Current): Promise<void> {
    const { home, keychain } = this.deps;
    const token = current.token!;
    const item = await beginItem(home, "", this.now(), current.setup);
    // Ended while it waited for the lock: macOS isn't asked at all.
    if (!this.goesOn(current)) {
      await dropNote(home, item);
      this.still(current);
    }
    try {
      await keychain.store(item, token);
    } catch {
      // Reading it back says what became of it.
    }
    let read: TokenRead = { state: "unknown" };
    try {
      read = await keychain.read({ slot: "own", item });
    } catch {
      // Unknown.
    }
    const open =
      keychain.kept === "keychain"
        ? " If a macOS window is still open, press Cancel there."
        : "";
    if (read.state === "found" && read.token === token) {
      await noteReady(home, item, botId(token));
      current.item = item;
      return;
    }
    if (read.state === "none") {
      await dropNote(home, item);
      throw new SetupProblem(
        `The token wasn't saved.${open} Nothing was changed; try again.`,
      );
    }
    await noteUnknown(home, item);
    throw new SetupProblem(
      `It isn't known whether the token was saved.${open} Nothing was changed; trying again uses a new place, and what may be left is shown below.`,
    );
  }

  /** After a problem in the first step, by the lead's click. */
  async again(id: string): Promise<SetupView> {
    const current = this.named(id);
    if (current.step !== "token" || !current.item)
      return refuse("setup_step", "That isn't the next step");
    await this.step(current, () => this.readItem(current));
    return this.view()!;
  }

  /** The lead agreed that the bot's waiting messages are read. */
  async code(id: string): Promise<SetupView> {
    const current = this.named(id);
    if (!["bot", "chat", "test"].includes(current.step))
      return refuse("setup_step", "That isn't the next step");
    if (current.busy) return refuse("setup_busy", "Wait a moment");
    const code = (this.deps.code ?? newCode)();
    current.chat = null;
    current.arrived = null;
    current.busy = true;
    current.problem = null;
    let shown!: () => void;
    const ready = new Promise<void>((done) => (shown = done));
    const round = (current.code = code);
    const active = () => !current.ended && current.code === round;
    void chatFromCode({
      client: this.deps.client(current.token!),
      code,
      shown: () => {
        if (active()) {
          current.step = "code";
          current.codeUntil = this.now() + CODE_MINUTES * 60_000;
          current.until = Math.max(current.until, current.codeUntil + 60_000);
          current.busy = false;
        }
        shown();
        this.deps.changed();
      },
      now: () => this.now(),
      sleep: (ms) => this.sleep(ms),
      stopped: () => !active() || this.live() !== current,
    })
      .then(
        (chat) => {
          if (!active()) return;
          current.chat = chat;
          current.step = "chat";
        },
        (error: unknown) => {
          if (!active()) return;
          current.problem = problemText(error);
          current.step = "bot";
        },
      )
      .finally(() => {
        if (active()) {
          current.busy = false;
          current.code = null;
        }
        shown();
        this.deps.changed();
      });
    await ready;
    return this.view() ?? refuse("setup_ended", "This setup has ended");
  }

  async sendTest(id: string): Promise<SetupView> {
    const current = this.named(id);
    if (!["chat", "test", "finish"].includes(current.step) || !current.chat)
      return refuse("setup_step", "That isn't the next step");
    if (current.tests >= TESTS)
      return refuse("setup_tests", "That is enough tests; start again");
    await this.step(current, async () => {
      current.tests += 1;
      await this.deps
        .client(current.token!)
        .send(current.chat!.id, "Konfab: test");
      this.still(current);
      current.step = "test";
      current.arrived = null;
    });
    return this.view()!;
  }

  /** Whether the test came; without one, that it is the lead's own chat. */
  confirm(id: string, arrived: boolean): SetupView {
    const current = this.named(id);
    if (current.busy) return refuse("setup_busy", "Wait a moment");
    if (!["chat", "test"].includes(current.step) || !current.chat)
      return refuse("setup_step", "That isn't the next step");
    if (!arrived) {
      current.problem =
        "Then look at the chat's name and the bot, and send a new code.";
      current.step = "bot";
      current.chat = null;
    } else {
      current.arrived = current.step === "test" ? true : null;
      current.problem = null;
      current.step = "finish";
    }
    this.deps.changed();
    return this.view()!;
  }

  async finish(id: string, enabled: boolean): Promise<void> {
    const current = this.named(id);
    if (current.step !== "finish" || !current.chat || !current.token)
      return refuse("setup_step", "That isn't the next step");
    let old: string | null = null;
    let done = false;
    await this.step(current, async () => {
      if (current.way === "paste" && !current.item)
        await this.storePasted(current);
      const next = {
        chat_id: current.chat!.id,
        chat_name: current.chat!.name,
        enabled,
        ...(current.way === "env"
          ? { slot: "env" as const }
          : { slot: "own" as const, item: current.item! }),
        bot_id: botId(current.token!),
        setup_id: current.setup,
      };
      const result = await commit(
        this.deps.home,
        next,
        current.began,
        this.now(),
        // Not ended meanwhile, by the lead or by time: whichever is first,
        // this or the saving, the other no longer happens.
        () => this.goesOn(current),
        (what) => {
          if (what !== "settings") return;
          done = true;
          this.end();
        },
      );
      old = result.old;
      if (done) return;
      this.still(current);
      throw new SetupProblem(
        "Phone notices were changed meanwhile, or this setup's token was removed. Nothing was changed; start again.",
      );
    });
    if (!done)
      return refuse(
        current.ended ? "setup_ended" : "setup_changed",
        current.problem ?? "Not saved",
      );
    // The replaced setup's own item, which nothing can use any more.
    if (old) await this.forget(old);
  }

  cancel(id: string): void {
    this.named(id);
    this.end();
  }

  /** Only what can't come into use again. */
  private async forget(item: string): Promise<boolean> {
    if (this.deleting.has(item)) return false;
    this.deleting.add(item);
    try {
      const given = await giveUp(
        this.deps.home,
        item,
        this.live()?.setup ?? null,
      );
      if (!given) return false;
      const result = await this.deps.keychain.remove(given);
      if (result === "unknown") return false;
      await dropNote(this.deps.home, given);
      return true;
    } finally {
      this.deleting.delete(item);
      this.deps.changed();
    }
  }

  /** By the lead's click. One of an earlier version only after its question. */
  async removeLeftOver(item: string, mayBeUsedElsewhere: boolean) {
    const found = this.leftOvers().find((one) => one.item === item);
    if (!found) return refuse("left_over", "That isn't a left-over any more");
    if (found.old && !mayBeUsedElsewhere)
      return refuse("left_over_old", "Another Konfab folder may use it");
    if (!(await this.forget(item)))
      return refuse(
        "left_over_unknown",
        `It isn't known whether it was removed. It is kept ${keptIn(this.deps.keychain.kept)}, named ${item}.`,
      );
  }

  /** The current setup: off and away first, then its own token. */
  async remove(): Promise<void> {
    this.end();
    const { item } = await removeSetup(this.deps.home, this.now());
    this.deps.changed();
    if (item && isOwnItem(item)) await this.forget(item);
  }

  /** A test with the setup that is in use. */
  async test(): Promise<void> {
    const settings = readSettings(this.deps.home);
    if (!settings) return refuse("not_set_up", "Phone notices aren't set up");
    const now = this.now();
    this.tests = this.tests.filter((at) => at > now - 3_600_000 && at <= now);
    if (this.tests.length >= TESTS_AN_HOUR)
      return refuse("too_many_tests", "That is enough tests for this hour");
    this.tests.push(now);
    const read = await this.deps.keychain.read(settings);
    if (read.state !== "found" || botId(read.token) !== settings.bot_id)
      return refuse(
        "no_token",
        read.state === "unknown"
          ? "The stored bot token couldn't be read."
          : "The bot token isn't stored any more, or is for another bot. Set it up again.",
      );
    if (readSettings(this.deps.home)?.setup_id !== settings.setup_id)
      return refuse("setup_changed", "Phone notices were changed meanwhile");
    try {
      await this.deps.client(read.token).send(settings.chat_id, "Konfab: test");
    } catch (error) {
      return refuse("test_failed", problemText(error));
    }
  }
}
