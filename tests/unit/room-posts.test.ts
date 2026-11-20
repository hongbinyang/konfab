import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexPostApproval,
  configureCodex,
  setCodexPostApproval,
} from "../../src/cli/connector-config.js";
import {
  allowRoomPosts,
  askBeforeRoomPosts,
  keepOwnershipAfterSetup,
  ownsRoomPosts,
  roomPostsHooks,
  roomPostsStatus,
} from "../../src/cli/room-posts.js";

const entry = {
  command: "node",
  args: ["/k/dist/bridge/index.js"],
  env: { KONFAB_URL: "http://127.0.0.1:8787", KONFAB_TOKEN: "t" },
};

describe("Codex approval for Konfab's post_message", () => {
  let dir: string;
  let codex: string;
  let state: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "konfab-room-posts-"));
    codex = join(dir, "config.toml");
    state = join(dir, "client-settings.json");
    writeFileSync(
      codex,
      configureCodex(
        '# mine\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "o"\n',
        entry,
      ),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const text = () => readFileSync(codex, "utf8");
  const value = () => codexPostApproval(text());
  /** A write by someone else: new contents and a new modification time. */
  let tick = 0;
  const userWrites = (contents: string) => {
    writeFileSync(codex, contents);
    tick += 5;
    const later = new Date(Date.now() + tick * 1000);
    utimesSync(codex, later, later);
  };

  it("is changed only for post_message and undone while the file is still Konfab's", () => {
    expect(roomPostsStatus(codex, state)).toEqual({ kind: "ask" });
    expect(allowRoomPosts(codex, state)).toContain(
      "Only Konfab's post_message is affected",
    );
    expect(value()).toBe("approve");
    expect(text()).toContain("# mine");
    expect(text()).toContain("[mcp_servers.other]");
    expect(text()).not.toContain("default_tools_approval_mode");
    expect(ownsRoomPosts(codex, state)).toBe(true);
    // Running it again changes nothing.
    const before = text();
    allowRoomPosts(codex, state);
    expect(text()).toBe(before);
    expect(askBeforeRoomPosts(codex, state)).toContain("will ask again");
    expect(value()).toBeUndefined();
    expect(text()).toContain("# mine");
    expect(readdirSync(dir)).not.toContain("client-settings.json");
  });

  it("stays Konfab's across Konfab's own setup rewrite of the connector entry", () => {
    allowRoomPosts(codex, state);
    const ownedText = text();
    expect(ownsRoomPosts(codex, state)).toBe(true);
    const after = configureCodex(ownedText, {
      ...entry,
      env: { ...entry.env, KONFAB_TOKEN: "t2" },
    });
    writeFileSync(codex, after);
    keepOwnershipAfterSetup(codex, state, ownedText, {
      before: ownedText,
      after,
    });
    expect(value()).toBe("approve");
    expect(roomPostsStatus(codex, state)).toEqual({
      kind: "allowed_by_konfab",
    });
  });

  it("doesn't carry ownership over a setup write that started from someone else's edit", () => {
    allowRoomPosts(codex, state);
    const ownedText = text();
    // Between the ownership check and setup's write, the user edits the file.
    const edited = ownedText.replace('model = "x"', 'model = "y"');
    userWrites(edited);
    const after = configureCodex(edited, {
      ...entry,
      env: { ...entry.env, KONFAB_TOKEN: "t2" },
    });
    writeFileSync(codex, after);
    keepOwnershipAfterSetup(codex, state, ownedText, { before: edited, after });
    expect(ownsRoomPosts(codex, state)).toBe(false);
    expect(askBeforeRoomPosts(codex, state)).toContain(
      "Konfab can't tell that this value is still the one it set",
    );
    expect(value()).toBe("approve");
  });

  it("doesn't carry ownership when the file changed after setup's write", () => {
    allowRoomPosts(codex, state);
    const ownedText = text();
    const after = configureCodex(ownedText, {
      ...entry,
      env: { ...entry.env, KONFAB_TOKEN: "t2" },
    });
    writeFileSync(codex, after);
    // Someone writes right after setup's write, before ownership is recorded.
    userWrites(after.replace('model = "x"', 'model = "z"'));
    keepOwnershipAfterSetup(codex, state, ownedText, {
      before: ownedText,
      after,
    });
    expect(ownsRoomPosts(codex, state)).toBe(false);
  });

  it("doesn't remove the value when the user edits between undo's check and its write", () => {
    allowRoomPosts(codex, state);
    roomPostsHooks.beforeWrite = () =>
      userWrites(text().replace('model = "x"', 'model = "y"'));
    try {
      expect(askBeforeRoomPosts(codex, state)).toContain(
        "Konfab can't tell that this value is still the one it set",
      );
    } finally {
      roomPostsHooks.beforeWrite = undefined;
    }
    expect(value()).toBe("approve");
    expect(text()).toContain('model = "y"');
  });

  it("keeps a value the user chose before opting in, or after", () => {
    userWrites(setCodexPostApproval(text(), "prompt"));
    expect(allowRoomPosts(codex, state)).toContain('approval_mode = "prompt"');
    expect(value()).toBe("prompt");
    userWrites(setCodexPostApproval(text(), undefined));
    allowRoomPosts(codex, state);
    userWrites(setCodexPostApproval(text(), "writes"));
    expect(askBeforeRoomPosts(codex, state)).toContain("Konfab leaves it");
    expect(value()).toBe("writes");
  });

  it("leaves a value that was changed away and back after Konfab set it", () => {
    allowRoomPosts(codex, state);
    userWrites(setCodexPostApproval(text(), "prompt"));
    userWrites(setCodexPostApproval(text(), "approve"));
    expect(roomPostsStatus(codex, state)).toEqual({
      kind: "allowed_elsewhere",
    });
    expect(askBeforeRoomPosts(codex, state)).toContain(
      "Konfab can't tell that this value is still the one it set",
    );
    expect(value()).toBe("approve");
  });

  it("leaves the value when any other edit touched the file after Konfab's write", () => {
    allowRoomPosts(codex, state);
    userWrites(text().replace('model = "x"', 'model = "y"'));
    expect(askBeforeRoomPosts(codex, state)).toContain(
      "Konfab can't tell that this value is still the one it set",
    );
    expect(value()).toBe("approve");
  });

  it("treats an identical value added after an interrupted opt-in as the user's", () => {
    // Interrupted after journalling the intent, before writing the config.
    const original = text();
    allowRoomPosts(codex, state);
    const journal = JSON.parse(readFileSync(state, "utf8"));
    userWrites(original);
    writeFileSync(
      state,
      JSON.stringify({
        codex_post_message: { ...journal.codex_post_message, state: "pending" },
      }),
    );
    // The user independently adds exactly what Konfab would have written.
    userWrites(setCodexPostApproval(original, "approve"));
    expect(allowRoomPosts(codex, state)).toContain(
      "earlier Konfab setup was interrupted",
    );
    expect(ownsRoomPosts(codex, state)).toBe(false);
    expect(askBeforeRoomPosts(codex, state)).toContain("Konfab leaves it");
    expect(value()).toBe("approve");
  });

  it("finishes an interrupted opt-in when the file never changed", () => {
    const original = text();
    allowRoomPosts(codex, state);
    const journal = JSON.parse(readFileSync(state, "utf8"));
    userWrites(original);
    writeFileSync(
      state,
      JSON.stringify({
        codex_post_message: { ...journal.codex_post_message, state: "pending" },
      }),
    );
    allowRoomPosts(codex, state);
    expect(value()).toBe("approve");
    expect(ownsRoomPosts(codex, state)).toBe(true);
  });

  it("does nothing without Codex", () => {
    rmSync(codex);
    expect(allowRoomPosts(codex, state)).toContain("Codex isn't set up here");
    expect(readdirSync(dir)).toEqual([]);
  });
});
