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
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
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

  describe("npm run doctor", () => {
    it("diagnoses a checkout without dependencies or a build, and writes nothing", () => {
      const root = join(dir, "bare");
      mkdirSync(join(root, "scripts"), { recursive: true });
      for (const file of ["doctor.mjs", "quickstart.mjs"])
        cpSync(join("scripts", file), join(root, "scripts", file));
      writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
      const before = snapshot(root);
      const result = spawnSync(
        process.execPath,
        [join(root, "scripts", "doctor.mjs")],
        {
          encoding: "utf8",
          env: { ...process.env, ...sentinelEnv },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("FAIL  Dependencies: Not installed.");
      expect(result.stdout).toContain("FAIL  Build: Konfab isn't built yet.");
      expect(snapshot(root)).toEqual(before);
    });

    it("runs the full checks on a built checkout without changing the build, the install or the caller's files", () => {
      const watched = (path: string) =>
        existsSync(path) ? snapshot(path) : {};
      const dist = watched("dist");
      const record = existsSync("node_modules/.konfab-install.json")
        ? readFileSync("node_modules/.konfab-install.json", "utf8")
        : null;
      const real = snapshot(sentinel);
      const result = spawnSync(process.execPath, ["scripts/doctor.mjs"], {
        encoding: "utf8",
        env: { ...process.env, ...sentinelEnv },
      });
      expect(result.stdout).toContain("Connector: Codex");
      expect(watched("dist")).toEqual(dist);
      expect(
        existsSync("node_modules/.konfab-install.json")
          ? readFileSync("node_modules/.konfab-install.json", "utf8")
          : null,
      ).toBe(record);
      expect(snapshot(sentinel)).toEqual(real);
    });
  });

  describe("starting from quickstart", () => {
    let env: Record<string, string>;
    let port: number;
    let children: Array<{ kill: () => void }>;
    const start = async (options: Record<string, unknown> = {}) => {
      const { startKonfab } = (await import(
        new URL("../../scripts/quickstart.mjs", import.meta.url).href
      )) as {
        startKonfab: (options: Record<string, unknown>) => Promise<{
          status: string;
          link: string;
          child?: { kill: () => void };
        }>;
      };
      const started = await startKonfab({
        env,
        open: false,
        stdio: "ignore",
        ...options,
      });
      if (started.child) children.push(started.child);
      return started;
    };
    beforeEach(async () => {
      children = [];
      const probe = createServer();
      await new Promise<void>((done) =>
        probe.listen(0, "127.0.0.1", () => done()),
      );
      port = (probe.address() as AddressInfo).port;
      await new Promise((done) => probe.close(done));
      const home = join(dir, "start");
      mkdirSync(join(home, ".konfab"), { recursive: true });
      writeFileSync(
        join(home, ".konfab", "config.yaml"),
        `server:\n  port: ${port}\n`,
      );
      env = {
        ...(process.env as Record<string, string>),
        HOME: home,
        KONFAB_HOME: join(home, ".konfab"),
        KONFAB_ISOLATED: "1",
      };
    });
    afterEach(() => {
      for (const child of children) child.kill();
    });

    it("starts, then finds the same Konfab running instead of starting a second one", async () => {
      const first = await start();
      expect(first.status).toBe("started");
      expect(first.link).toContain(`127.0.0.1:${port}/login?code=`);
      const second = await start();
      expect(second).toMatchObject({ status: "already-running" });
      expect(second.child).toBeUndefined();
      // The new link signs in.
      const response = await fetch(second.link, { redirect: "manual" });
      expect(response.status).toBe(303);
    });

    it("refuses a port used by another program", async () => {
      const other = createHttpServer((_, response) =>
        response.end("not konfab"),
      );
      await new Promise<void>((done) =>
        other.listen(port, "127.0.0.1", () => done()),
      );
      try {
        await expect(start()).rejects.toThrow(
          `Port ${port} is in use by another program`,
        );
      } finally {
        await new Promise((done) => other.close(done));
      }
    });

    it("reports a server that stops before it is ready, and a sign-in link that can't be made", async () => {
      const crash = join(dir, "crash.mjs");
      writeFileSync(crash, "process.exit(3);\n");
      await expect(start({ serverScript: crash })).rejects.toThrow(
        "The server stopped (exit code 3) before it was ready",
      );
      const broken = join(dir, "broken-link.mjs");
      writeFileSync(
        broken,
        "console.error('database locked'); process.exit(1);\n",
      );
      await expect(start({ loginScript: broken })).rejects.toThrow(
        "Couldn't create a sign-in link: database locked",
      );
    });

    it("gives up on a server that never answers, and stops it", async () => {
      const silent = join(dir, "silent.mjs");
      writeFileSync(silent, "setInterval(() => {}, 1000);\n");
      await expect(
        start({ serverScript: silent, timeoutMs: 1500 }),
      ).rejects.toThrow("didn't answer within 1.5 seconds");
    });
  });
});
