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

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const portIsFree = () =>
      new Promise<boolean>((done) => {
        const probe = createServer();
        probe.once("error", () => done(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
      });

    it("starts once the server itself reports ready, and refuses to start a second one", async () => {
      const first = await start();
      expect(first.status).toBe("started");
      expect(first.link).toContain(`127.0.0.1:${port}/login?code=`);
      expect((await fetch(first.link, { redirect: "manual" })).status).toBe(
        303,
      );
      await expect(start()).rejects.toThrow("npm run login-link");
    });

    it("never sends a sign-in code to another program on the port", async () => {
      const requests: string[] = [];
      const other = createHttpServer((request, response) => {
        requests.push(request.url ?? "");
        response.end("not konfab");
      });
      await new Promise<void>((done) =>
        other.listen(port, "127.0.0.1", () => done()),
      );
      try {
        await expect(start()).rejects.toThrow(`Port ${port} is already in use`);
        expect(requests).toEqual([]);
      } finally {
        await new Promise((done) => other.close(done));
      }
    });

    it("stops and reaps the server on every failure after starting it", async () => {
      // Exits before ready.
      const crash = join(dir, "crash.mjs");
      writeFileSync(crash, "process.exit(3);\n");
      await expect(start({ serverScript: crash })).rejects.toThrow(
        "The server stopped (exit code 3) before it was ready",
      );
      // Never reports ready: stopped after the timeout.
      const pidFile = join(dir, "silent.pid");
      const silent = join(dir, "silent.mjs");
      writeFileSync(
        silent,
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`.replace(
          'require("node:fs")',
          '(await import("node:fs"))',
        ),
      );
      await expect(
        start({ serverScript: silent, timeoutMs: 1500 }),
      ).rejects.toThrow("didn't report ready within 1.5 seconds");
      expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
      // Ready, but the sign-in link then can't be made: the real server is stopped.
      const calls = join(dir, "calls");
      const flaky = join(dir, "flaky-link.mjs");
      writeFileSync(
        flaky,
        `import { existsSync, writeFileSync } from "node:fs";
if (existsSync(${JSON.stringify(calls)})) { console.error("database locked"); process.exit(1); }
writeFileSync(${JSON.stringify(calls)}, "1");
console.log("http://127.0.0.1:${port}/login?code=x");
`,
      );
      await expect(start({ loginScript: flaky })).rejects.toThrow(
        "Couldn't create a sign-in link: database locked",
      );
      expect(await portIsFree()).toBe(true);
    });
  });

  it("turns Codex's post_message approval on by default, and remembers when the lead turns it off", () => {
    const home = join(dir, "posts");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), "{}\n");
    const env = {
      ...process.env,
      HOME: home,
      KONFAB_HOME: join(home, ".konfab"),
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: home,
      KONFAB_ISOLATED: "1",
    };
    const setup = (...flags: string[]) =>
      spawnSync(process.execPath, ["dist/cli/setup.js", ...flags], {
        env,
        encoding: "utf8",
      });
    const codex = () =>
      readFileSync(join(home, ".codex", "config.toml"), "utf8");
    const approved = /post_message[\s\S]*approval_mode = "approve"/;
    // Plain setup turns it on, only for post_message; Claude Code isn't touched.
    const first = setup();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Only Konfab's post_message is affected");
    expect(codex()).toMatch(approved);
    expect(codex()).not.toContain("default_tools_approval_mode");
    expect(readFileSync(join(home, ".claude.json"), "utf8")).not.toContain(
      "permissions",
    );
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    // A rerun keeps it; doctor reports it.
    setup();
    expect(codex()).toMatch(approved);
    const doctor = spawnSync(process.execPath, ["dist/cli/doctor.js"], {
      env,
      encoding: "utf8",
    });
    expect(doctor.stdout).toContain(
      "Room posts (Codex): Codex posts in Konfab rooms without asking each time (you turned this on",
    );
    // Turning it off is remembered by later plain runs.
    expect(setup("--ask-before-room-posts").stdout).toContain("will ask again");
    expect(codex()).not.toContain("approval_mode");
    expect(setup().stdout).toContain("You chose to be asked");
    expect(codex()).not.toContain("approval_mode");
    // And --allow-room-posts turns it back on.
    setup("--allow-room-posts");
    expect(codex()).toMatch(approved);
  });

  describe("an existing Codex setting for Konfab's post_message", () => {
    const run = (initial: string) => {
      const home = join(dir, `existing-${initial}`);
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".claude.json"), "{}\n");
      // The user's own value, set before Konfab ever touched it.
      writeFileSync(
        join(home, ".codex", "config.toml"),
        `[mcp_servers.konfab.tools.post_message]\napproval_mode = "${initial}"\n`,
      );
      const env = {
        ...process.env,
        HOME: home,
        KONFAB_HOME: join(home, ".konfab"),
        CODEX_HOME: join(home, ".codex"),
        CLAUDE_CONFIG_DIR: home,
        KONFAB_ISOLATED: "1",
      };
      const setup = (...flags: string[]) =>
        spawnSync(process.execPath, ["dist/cli/setup.js", ...flags], {
          env,
          encoding: "utf8",
        });
      const value = () =>
        /approval_mode = "([a-z]+)"/.exec(
          readFileSync(join(home, ".codex", "config.toml"), "utf8"),
        )?.[1];
      return { setup, value };
    };

    it("keeps a custom value through the default and the opt-out", () => {
      const { setup, value } = run("prompt");
      expect(setup().stdout).toContain(
        'Codex has its own setting for Konfab\'s post_message (approval_mode = "prompt"); Konfab leaves it as it is.',
      );
      expect(value()).toBe("prompt");
      expect(setup("--ask-before-room-posts").stdout).toContain(
        'approval_mode = "prompt"',
      );
      expect(value()).toBe("prompt");
    });

    it("keeps an approve value Konfab didn't set through the default and the opt-out", () => {
      const { setup, value } = run("approve");
      expect(setup().stdout).toContain("not provably set by Konfab setup");
      expect(value()).toBe("approve");
      expect(setup("--ask-before-room-posts").stdout).toContain(
        "Konfab leaves it; remove [mcp_servers.konfab.tools.post_message]",
      );
      expect(value()).toBe("approve");
    });
  });
});
