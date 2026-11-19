import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedEnvironment } from "../../src/cli/check.js";
import { diagnose } from "../../src/cli/doctor.js";

/** Every file under a folder with its hash, to prove nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else
        files[relative(dir, full)] = createHash("sha256")
          .update(readFileSync(full))
          .digest("hex");
    }
  };
  visit(dir);
  return files;
}

describe("getting started", () => {
  let dir: string;
  let sentinel: string;
  let sentinelEnv: Record<string, string>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "konfab-get-started-"));
    // A real-looking user setup that nothing may touch.
    sentinel = join(dir, "real");
    mkdirSync(join(sentinel, ".codex"), { recursive: true });
    mkdirSync(join(sentinel, ".konfab"), { recursive: true });
    writeFileSync(
      join(sentinel, ".codex", "config.toml"),
      '[mcp_servers.other]\ncommand = "x"\n',
    );
    writeFileSync(join(sentinel, ".claude.json"), '{"mcpServers":{}}\n');
    writeFileSync(
      join(sentinel, ".konfab", "config.yaml"),
      "server:\n  port: 8787\n",
    );
    sentinelEnv = {
      HOME: sentinel,
      KONFAB_HOME: join(sentinel, ".konfab"),
      CODEX_HOME: join(sentinel, ".codex"),
      CLAUDE_CONFIG_DIR: sentinel,
      KONFAB_GITHUB_TOKEN: "ghp_secret_never_used",
      ANTHROPIC_API_KEY: "secret",
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the check isolates itself from the caller's homes and credentials", () => {
    const env = isolatedEnvironment(
      { ...process.env, ...sentinelEnv },
      join(dir, "iso"),
    );
    expect(env.HOME).toBe(join(dir, "iso", "home"));
    expect(env.KONFAB_HOME).toBe(join(dir, "iso", "konfab"));
    expect(env.CODEX_HOME).toBe(join(dir, "iso", "home", ".codex"));
    expect(env.KONFAB_GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.KONFAB_ISOLATED).toBe("1");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("runs the full check without touching the caller's real setup", () => {
    const before = snapshot(sentinel);
    const result = spawnSync(process.execPath, ["dist/cli/check.js"], {
      env: { ...process.env, ...sentinelEnv },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.stdout).toContain("Check passed.");
    expect(result.status).toBe(0);
    expect(snapshot(sentinel)).toEqual(before);
    // Its own temporary folder is gone.
    const folder = /Working in (\S+) /.exec(result.stdout)?.[1] ?? "";
    expect(folder).toContain("konfab-check-");
    expect(existsSync(folder)).toBe(false);
  });

  it("doctor creates and changes nothing", async () => {
    const missing = join(dir, "nobody");
    await diagnose({
      ...sentinelEnv,
      HOME: missing,
      KONFAB_HOME: join(missing, ".konfab"),
    });
    expect(existsSync(missing)).toBe(false);
    const before = snapshot(sentinel);
    const findings = await diagnose(sentinelEnv);
    expect(snapshot(sentinel)).toEqual(before);
    expect(
      findings.find((item) => item.check === "Connector: Codex"),
    ).toMatchObject({
      level: "fail",
      detail: expect.stringContaining("No konfab entry"),
    });
  });

  it("doctor explains an invalid config without telling the lead to delete it", async () => {
    writeFileSync(
      join(sentinel, ".konfab", "config.yaml"),
      "server:\n  port: nope\n",
    );
    const config = (await diagnose(sentinelEnv)).find(
      (item) => item.check === "Config",
    );
    expect(config?.level).toBe("fail");
    expect(config?.fix).toContain(".bak");
    expect(config?.fix).not.toMatch(/\bdelete\b/i);
  });

  it("setup doesn't create configuration for an app that isn't there", () => {
    const home = join(dir, "fresh");
    mkdirSync(home);
    writeFileSync(join(home, ".claude.json"), "{}\n");
    const result = spawnSync(process.execPath, ["dist/cli/setup.js"], {
      env: {
        ...process.env,
        HOME: home,
        KONFAB_HOME: join(home, ".konfab"),
        CODEX_HOME: join(home, ".codex"),
        CLAUDE_CONFIG_DIR: home,
        KONFAB_ISOLATED: "1",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(result.stdout).toContain("Codex not found");
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toContain(
      "konfab",
    );
  });

  describe("quickstart's install policy", () => {
    const project = () => {
      const root = join(dir, "project");
      mkdirSync(join(root, "scripts"), { recursive: true });
      cpSync("scripts/quickstart.mjs", join(root, "scripts", "quickstart.mjs"));
      writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
      return root;
    };

    it("records only a matching lockfile, Node ABI, platform and CPU", async () => {
      const root = project();
      const { fingerprint, installMatches } = (await import(
        join(root, "scripts", "quickstart.mjs")
      )) as {
        fingerprint: (root: string) => Record<string, string>;
        installMatches: (root: string) => boolean;
      };
      mkdirSync(join(root, "node_modules"));
      const record = join(root, "node_modules", ".konfab-install.json");
      expect(installMatches(root)).toBe(false);
      writeFileSync(record, JSON.stringify(fingerprint(root)));
      expect(installMatches(root)).toBe(true);
      writeFileSync(
        join(root, "package-lock.json"),
        '{"lockfileVersion":3,"x":1}\n',
      );
      expect(installMatches(root)).toBe(false);
      writeFileSync(record, JSON.stringify({ ...fingerprint(root), abi: "1" }));
      expect(installMatches(root)).toBe(false);
    });

    it("never reinstalls through a linked node_modules", () => {
      const root = project();
      const shared = join(dir, "shared-node_modules");
      mkdirSync(shared);
      writeFileSync(join(shared, "keep.txt"), "keep");
      symlinkSync(shared, join(root, "node_modules"));
      const result = spawnSync(
        process.execPath,
        [join(root, "scripts", "quickstart.mjs")],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is a link to another folder");
      expect(readFileSync(join(shared, "keep.txt"), "utf8")).toBe("keep");
      expect(statSync(join(root, "node_modules")).isDirectory()).toBe(true);
    });
  });
});
