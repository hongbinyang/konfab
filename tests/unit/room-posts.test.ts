import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  const value = () => codexPostApproval(readFileSync(codex, "utf8"));

  it("is changed only for post_message, kept across a setup rerun, and undone exactly", () => {
    expect(roomPostsStatus(codex, state)).toEqual({ kind: "ask" });
    expect(allowRoomPosts(codex, state)).toContain(
      "Only Konfab's post_message is affected",
    );
    expect(value()).toBe("approve");
    const text = readFileSync(codex, "utf8");
    expect(text).toContain("# mine");
    expect(text).toContain("[mcp_servers.other]");
    expect(text).not.toContain("default_tools_approval_mode");
    // Setup rewrites the connector entry; the approval stays.
    writeFileSync(
      codex,
      configureCodex(text, {
        ...entry,
        env: { ...entry.env, KONFAB_TOKEN: "t2" },
      }),
    );
    expect(value()).toBe("approve");
    expect(roomPostsStatus(codex, state)).toEqual({
      kind: "allowed_by_konfab",
    });
    // Running it again changes nothing.
    const before = readFileSync(codex, "utf8");
    allowRoomPosts(codex, state);
    expect(readFileSync(codex, "utf8")).toBe(before);
    expect(askBeforeRoomPosts(codex, state)).toContain("will ask again");
    expect(value()).toBeUndefined();
    expect(readFileSync(codex, "utf8")).toContain("# mine");
    expect(readdirSync(dir)).not.toContain("client-settings.json");
  });

  it("keeps a value the user chose, before or after opting in", () => {
    writeFileSync(
      codex,
      setCodexPostApproval(readFileSync(codex, "utf8"), "prompt"),
    );
    expect(allowRoomPosts(codex, state)).toContain('approval_mode = "prompt"');
    expect(value()).toBe("prompt");
    // Opt in, then the user changes it: undo leaves their value.
    writeFileSync(
      codex,
      setCodexPostApproval(readFileSync(codex, "utf8"), undefined),
    );
    allowRoomPosts(codex, state);
    writeFileSync(
      codex,
      setCodexPostApproval(readFileSync(codex, "utf8"), "writes"),
    );
    expect(askBeforeRoomPosts(codex, state)).toContain("leaves your value");
    expect(value()).toBe("writes");
  });

  it("leaves an approval Konfab didn't set, and finishes an interrupted opt-in", () => {
    writeFileSync(
      codex,
      setCodexPostApproval(readFileSync(codex, "utf8"), "approve"),
    );
    expect(roomPostsStatus(codex, state)).toEqual({
      kind: "allowed_elsewhere",
    });
    expect(askBeforeRoomPosts(codex, state)).toContain("Konfab didn't set it");
    expect(value()).toBe("approve");
    // Interrupted after recording the intent, before writing the config.
    writeFileSync(
      codex,
      setCodexPostApproval(readFileSync(codex, "utf8"), undefined),
    );
    writeFileSync(
      state,
      JSON.stringify({ codex_post_message: { state: "pending", path: codex } }),
    );
    allowRoomPosts(codex, state);
    expect(value()).toBe("approve");
    expect(
      JSON.parse(readFileSync(state, "utf8")).codex_post_message.state,
    ).toBe("applied");
  });

  it("does nothing without Codex", () => {
    rmSync(codex);
    expect(allowRoomPosts(codex, state)).toContain("Codex isn't set up here");
    expect(readdirSync(dir)).toEqual([]);
  });
});
