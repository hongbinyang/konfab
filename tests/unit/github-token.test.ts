import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubTokenCommand } from "../../src/server/github-token.js";
import {
  GithubToken,
  readPointer,
} from "../../src/server/github/token-store.js";
import { FakeKeychain } from "./fake-keychain.js";

// Made up; no test calls GitHub or uses a Keychain.
const TOKEN = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EARLIER = "konfab-github-token";

describe("the GitHub token", () => {
  let home: string;
  let keychain: FakeKeychain;
  let env: NodeJS.ProcessEnv;
  let accepts: (token: string) => Promise<boolean>;
  let changes: (string | undefined)[];
  const make = () =>
    new GithubToken({
      home,
      keychain: keychain as never,
      env,
      accepts: (token) => accepts(token),
      changed: (token) => void changes.push(token),
    });
  let store: GithubToken;
  const files = () =>
    ["github-token.json", "github-notes.json"].map((name) =>
      existsSync(join(home, name))
        ? readFileSync(join(home, name), "utf8")
        : null,
    );

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "konfab-github-"));
    keychain = new FakeKeychain(TOKEN);
    env = {};
    accepts = async () => true;
    changes = [];
    store = make();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("uses the environment first, then this folder's place, and the earlier one only without a pointer", async () => {
    keychain.items.set(EARLIER, OTHER);
    await store.load();
    expect([store.source, store.token]).toEqual(["earlier", OTHER]);
    env = { KONFAB_GITHUB_TOKEN: TOKEN };
    store = make();
    const reads = keychain.reads.length;
    await store.load();
    expect([store.source, store.token]).toEqual(["environment", TOKEN]);
    expect(keychain.reads).toHaveLength(reads);
    // A removed one names nothing: never a way back to the earlier place.
    env = {};
    writeFileSync(join(home, "github-token.json"), '{"item":null}');
    store = make();
    await store.load();
    expect([store.source, store.token]).toEqual(["none", undefined]);
    writeFileSync(join(home, "github-token.json"), "{broken");
    expect(readPointer(home)).toEqual({ item: null });
  });

  it("stores a new place, checked and read back, and only then uses it", async () => {
    keychain.items.set(EARLIER, OTHER);
    await store.load();
    await store.store(` ${TOKEN}\n`);
    const { item } = readPointer(home)!;
    expect(item).toMatch(/^konfab-github-token-[0-9a-f]{32}$/);
    expect(keychain.items.get(item!)).toBe(TOKEN);
    expect([store.source, store.token]).toEqual(["stored", TOKEN]);
    expect(changes.at(-1)).toBe(TOKEN);
    // The earlier place stays; it may be another folder's.
    expect(keychain.items.get(EARLIER)).toBe(OTHER);
    expect(store.view()).toMatchObject({ earlier_left: true, left_over: [] });
    // Replaced: a new place again, and the one before is deleted.
    keychain.token = OTHER;
    await store.store(OTHER);
    const next = readPointer(home)!.item!;
    expect(next).not.toBe(item);
    expect(keychain.items.has(item!)).toBe(false);
    expect(store.token).toBe(OTHER);
  });

  it.each<[string, () => void, RegExp]>([
    ["isn't a token", () => undefined, /isn't a GitHub token/],
    ["GitHub refuses it", () => (accepts = async () => false), /didn't accept/],
    [
      "GitHub can't be reached",
      () =>
        (accepts = async () => {
          throw new Error("offline");
        }),
      /can't be reached/,
    ],
    [
      "the environment has one",
      () => (env = { KONFAB_GITHUB_TOKEN: OTHER }),
      /KONFAB_GITHUB_TOKEN is set/,
    ],
    [
      "nothing can be stored",
      () => (keychain.usable = false),
      /Nothing can be stored/,
    ],
  ])("changes nothing when it %s", async (name, spoil, said) => {
    await store.store(TOKEN);
    const before = files();
    spoil();
    store = make();
    await expect(
      store.store(name === "isn't a token" ? "ghp_ x" : OTHER),
    ).rejects.toThrow(said);
    expect(files()).toEqual(before);
    expect(keychain.stores).toHaveLength(1);
  });

  it.each<[string, "nothing" | "unknown" | "another", RegExp, number]>([
    ["isn't stored", "nothing", /wasn't saved/, 0],
    ["can't be read back", "unknown", /isn't known/, 1],
    ["reads back as another", "another", /isn't known/, 1],
  ])(
    "keeps the token in use when the new one %s",
    async (_name, outcome, said, left) => {
      await store.store(TOKEN);
      const pointer = files()[0];
      keychain.pasted = outcome;
      keychain.token = OTHER;
      await expect(store.store(OTHER)).rejects.toThrow(said);
      expect(files()[0]).toBe(pointer);
      expect(store.token).toBe(TOKEN);
      expect(store.view().left_over).toHaveLength(left);
      expect(
        await store.store(OTHER).catch((error: Error) => error),
      ).toBeInstanceOf(Error);
    },
  );

  it("doesn't undo a change that another program made meanwhile", async () => {
    await store.store(TOKEN);
    const theirs = '{"item":"konfab-github-token-' + "c".repeat(32) + '"}';
    accepts = async () => {
      writeFileSync(join(home, "github-token.json"), theirs);
      return true;
    };
    await expect(store.store(OTHER)).rejects.toThrow(/changed meanwhile/);
    expect(files()[0]).toBe(theirs);
    // Its own new place isn't used, and may be removed.
    expect(store.view().left_over).toHaveLength(1);
    expect(store.token).toBe(TOKEN);
  });

  it("gives searches the token it holds, so that deleting a replaced place fails none", async () => {
    await store.store(TOKEN);
    const searching = store.token;
    const reads = keychain.reads.length;
    keychain.token = OTHER;
    await store.store(OTHER);
    // The search that began before still has a whole token.
    expect(searching).toBe(TOKEN);
    expect(store.token).toBe(OTHER);
    // Searches never ask the Keychain; only a store or a change does.
    for (let i = 0; i < 5; i += 1) void store.token;
    await store.look();
    expect(keychain.reads.length - reads).toBe(1);
  });

  it("never lets an older read put back an older token", async () => {
    // Each read waits until it is let go, in any order.
    const waiting: (() => void)[] = [];
    const read = keychain.read.bind(keychain);
    vi.spyOn(keychain, "read").mockImplementation(
      (place) =>
        new Promise((done) => waiting.push(() => void read(place).then(done))),
    );
    const other = make();
    const settle = () => new Promise((done) => setTimeout(done, 5));
    const pointTo = (item: string, token: string) => {
      keychain.items.set(item, token);
      writeFileSync(join(home, "github-token.json"), JSON.stringify({ item }));
    };
    const first = `konfab-github-token-${"1".repeat(32)}`;
    const second = `konfab-github-token-${"2".repeat(32)}`;
    pointTo(first, TOKEN);
    const a = store.load();
    // Another program (such as the command line) replaces it meanwhile.
    pointTo(second, OTHER);
    const b = store.load();
    await settle();
    waiting[1]!();
    await b;
    expect(store.token).toBe(OTHER);
    waiting[0]!();
    await a;
    expect(store.token).toBe(OTHER);
    // And removed meanwhile: the older answer doesn't bring it back.
    const c = store.look();
    writeFileSync(join(home, "github-token.json"), '{"item":null}');
    await other.load();
    const d = store.load();
    await settle();
    for (const go of waiting.splice(0)) go();
    await Promise.all([c, d]);
    expect([store.source, store.token]).toEqual(["none", undefined]);
    // A store in the page wins over a read that began before it.
    vi.restoreAllMocks();
    keychain.token = TOKEN;
    const e = store.load();
    await store.store(TOKEN);
    await e;
    expect(store.token).toBe(TOKEN);
    expect(store.source).toBe("stored");
  });

  it("takes a change by another program at its next look", async () => {
    await store.store(TOKEN);
    const other = make();
    await other.load();
    keychain.token = OTHER;
    await store.store(OTHER);
    expect(other.token).toBe(TOKEN);
    await other.look();
    expect(other.token).toBe(OTHER);
    await store.remove(false);
    await other.look();
    expect([other.source, other.token]).toEqual(["none", undefined]);
  });

  it("removes this folder's place, never the earlier one without a yes, and doesn't fall back", async () => {
    keychain.items.set(EARLIER, OTHER);
    await store.load();
    await expect(store.removeEarlier()).rejects.toThrow(/in use/);
    await store.store(TOKEN);
    const { item } = readPointer(home)!;
    await store.remove(false);
    expect(readPointer(home)).toEqual({ item: null });
    expect(keychain.items.has(item!)).toBe(false);
    expect(keychain.items.get(EARLIER)).toBe(OTHER);
    store = make();
    await store.load();
    expect(store.token).toBeUndefined();
    await store.removeEarlier();
    expect(keychain.items.has(EARLIER)).toBe(false);
  });

  it("keeps a place whose deletion isn't sure, and shows it", async () => {
    await store.store(TOKEN);
    keychain.keeps = true;
    await store.remove(false);
    expect(store.view().left_over).toHaveLength(1);
    expect(store.token).toBeUndefined();
  });

  it("is of one Konfab folder only", async () => {
    await store.store(TOKEN);
    const elsewhere = mkdtempSync(join(tmpdir(), "konfab-github-"));
    try {
      const theirs = new GithubToken({
        home: elsewhere,
        keychain: keychain as never,
        env,
        accepts: async () => true,
        changed: () => undefined,
      });
      await theirs.load();
      expect(theirs.source).toBe("none");
      await theirs.remove(false);
      expect(keychain.items.get(readPointer(home)!.item!)).toBe(TOKEN);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  describe("on the command line", () => {
    let said: string[];
    const run = (args: string[], typed: string | null = TOKEN) =>
      githubTokenCommand(["--github-token", ...args], {
        home,
        say: (line) => void said.push(line),
        ask: async () => typed,
        store,
      });
    beforeEach(() => (said = []));

    it("stores, says the state, and removes, by the same rules", async () => {
      expect(await run([])).toBe(true);
      expect(store.token).toBe(TOKEN);
      expect(said.join(" ")).not.toContain(TOKEN);
      said = [];
      expect(await run(["--status"])).toBe(true);
      expect(said[0]).toMatch(/^Stored in your Keychain/);
      expect(await run(["--remove"])).toBe(true);
      expect(readPointer(home)).toEqual({ item: null });
      expect(await run([], null)).toBe(false);
      accepts = async () => false;
      said = [];
      expect(await run([])).toBe(false);
      expect(said.at(-1)).toMatch(/didn't accept/);
    });

    it("refuses what it doesn't know", async () => {
      for (const args of [["--earlier"], ["--status", "--remove"], ["--x"]])
        await expect(run(args)).rejects.toThrow(/Use --github-token/);
    });
  });
});
