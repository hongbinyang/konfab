import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  status,
  tokenOnly,
  type SetupDeps,
} from "../../src/cli/telegram-setup.js";
import { readNotes } from "../../src/server/telegram/places.js";
import { Keychain, newItem } from "../../src/server/telegram/token.js";

const TOKEN_MODULE = pathToFileURL(
  join(import.meta.dirname, "../../src/server/telegram/token.ts"),
).href;
/** Lets a plain Node process load the sources, whose imports say ".js". */
const TS_IMPORTS = `import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(\`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) {
    if (!specifier.endsWith(".js")) throw error;
    return next(specifier.slice(0, -3) + ".ts", context);
  }
}\`));`;

// Made up.
const TOKEN = "1234567890:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr";
const OTHER = "5555555555:ZZbbCCddEEffGGhhIIjjKKllMMnnOOppQQr";

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "tokens in private files on Linux",
  () => {
    let home: string;
    let folder: string;
    let typed: (string | null)[];
    let started: number;
    const files = (env: NodeJS.ProcessEnv = {}, platform = "linux") =>
      new Keychain(
        env,
        platform as NodeJS.Platform,
        async () => {
          started += 1;
          return { code: 0, out: TOKEN };
        },
        { home, ask: async () => typed.shift() ?? null },
      );
    const own = (item: string) => ({ slot: "own" as const, item });
    const unknown = { state: "unknown" };
    const none = { state: "none" };

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "konfab-files-"));
      folder = join(home, "tokens");
      typed = [];
      started = 0;
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("keeps each token in a new file only for this user, and never runs macOS's command", async () => {
      const store = files();
      expect(store).toMatchObject({ kept: "file", usable: true });
      const item = newItem();
      expect(await store.read(own(item))).toEqual(none);
      typed = [`  ${TOKEN}  `];
      expect(await store.storeByHand(item)).toBe(true);
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(statSync(join(folder, item)).mode & 0o777).toBe(0o600);
      expect(await store.read(own(item))).toEqual({
        state: "found",
        token: TOKEN,
      });
      // Never replaced.
      typed = [OTHER];
      expect(await store.storeByHand(item)).toBe(false);
      expect(await store.read(own(item))).toMatchObject({ token: TOKEN });
      expect(await store.remove(item)).toBe("deleted");
      expect(await store.remove(item)).toBe("none");
      expect(await store.read(own(item))).toEqual(none);
      expect(started).toBe(0);
    });

    it("stores nothing that isn't a token, or when nothing was typed", async () => {
      for (const answer of [null, "", "not a token", `${TOKEN} more`]) {
        typed = [answer];
        expect(await files().storeByHand(newItem())).toBe(false);
      }
      expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
    });

    it("uses nothing that others could read or change, or that leads elsewhere", async () => {
      const item = newItem();
      typed = [TOKEN];
      await files().storeByHand(item);
      const path = join(folder, item);
      const cases: [string, () => void, () => void][] = [
        [
          "open file",
          () => chmodSync(path, 0o644),
          () => chmodSync(path, 0o600),
        ],
        [
          "open folder",
          () => chmodSync(folder, 0o755),
          () => chmodSync(folder, 0o700),
        ],
        [
          "a link",
          () => {
            rmSync(path);
            const elsewhere = join(home, "elsewhere");
            writeFileSync(elsewhere, TOKEN, { mode: 0o600 });
            symlinkSync(elsewhere, path);
          },
          () => {
            rmSync(path);
            writeFileSync(path, TOKEN, { mode: 0o600 });
          },
        ],
        [
          "not a token",
          () => writeFileSync(path, "x"),
          () => writeFileSync(path, TOKEN),
        ],
        [
          "too long",
          // Even if what is in it would be one.
          () => writeFileSync(path, `${TOKEN}${" ".repeat(10_000)}`),
          () => writeFileSync(path, TOKEN),
        ],
      ];
      for (const [name, spoil, mend] of cases) {
        spoil();
        expect(await files().read(own(item)), name).toEqual(unknown);
        mend();
        expect(await files().read(own(item)), name).toMatchObject({
          state: "found",
        });
      }
      chmodSync(folder, 0o755);
      typed = [TOKEN];
      expect(await files().storeByHand(newItem())).toBe(false);
      expect(await files().remove(item)).toBe("unknown");
      expect(existsSync(path)).toBe(true);
    });

    it("reads no pipe or other special file, and isn't held up by one", () => {
      const item = newItem();
      mkdirSync(folder, { mode: 0o700 });
      const path = join(folder, item);
      // In a process of its own: a read that waits would hold up this one.
      const read = (prepare: string) =>
        spawnSync(
          process.execPath,
          [
            "--experimental-transform-types",
            "--no-warnings",
            "--import",
            `data:text/javascript,${encodeURIComponent(TS_IMPORTS)}`,
            "--input-type=module",
            "-e",
            `${prepare}
            const { Keychain } = await import(${JSON.stringify(TOKEN_MODULE)});
            const store = new Keychain({}, "linux", undefined, { home: ${JSON.stringify(home)} });
            const started = Date.now();
            const read = await store.read({ slot: "own", item: ${JSON.stringify(item)} });
            const removed = await store.remove(${JSON.stringify(item)});
            console.log(JSON.stringify({ read, removed, ms: Date.now() - started }));`,
          ],
          { encoding: "utf8", timeout: 10_000 },
        );
      const pipe = spawnSync("/usr/bin/mkfifo", ["-m", "600", path]);
      expect(pipe.status).toBe(0);
      const socket = `const net = await import("node:net");
        const server = net.createServer().listen(${JSON.stringify(join(folder, "s"))});
        await new Promise((done) => server.once("listening", done));
        (await import("node:fs")).renameSync(${JSON.stringify(join(folder, "s"))}, ${JSON.stringify(path)});
        server.unref();`;
      for (const prepare of ["", socket]) {
        const ran = read(prepare);
        expect(ran.signal, ran.stderr).toBeNull();
        const answer = JSON.parse(ran.stdout.trim());
        expect(answer).toMatchObject({
          read: { state: "unknown" },
          removed: "deleted",
        });
        expect(answer.ms).toBeLessThan(2000);
        expect(ran.stdout + ran.stderr).not.toContain(TOKEN);
        expect(existsSync(path)).toBe(false);
      }
    });

    it("doesn't follow a folder that is a link", async () => {
      const elsewhere = join(home, "elsewhere");
      mkdirSync(elsewhere, { mode: 0o700 });
      symlinkSync(elsewhere, folder);
      const item = newItem();
      writeFileSync(join(elsewhere, item), TOKEN, { mode: 0o600 });
      expect(await files().read(own(item))).toEqual(unknown);
      expect(await files().remove(item)).toBe("unknown");
      typed = [TOKEN];
      expect(await files().storeByHand(newItem())).toBe(false);
      expect(readdirSync(elsewhere)).toEqual([item]);
    });

    it("has no place when isolated, without a folder, or on other systems", async () => {
      const item = newItem();
      typed = [TOKEN];
      await files().storeByHand(item);
      const isolated = files({ KONFAB_ISOLATED: "1" });
      expect(isolated.usable).toBe(false);
      expect(await isolated.read(own(item))).toEqual(none);
      expect(await isolated.remove(item)).toBe("unknown");
      expect(new Keychain({}, "linux").kept).toBeNull();
      expect(files({}, "win32").kept).toBeNull();
      expect(files({}, "darwin").kept).toBe("keychain");
      // The environment is never stored, and its file is never read for it.
      expect(await files({}).read({ slot: "env" })).toEqual(none);
    });

    it("works with the page's terminal command, and says where it is kept", async () => {
      const said: string[] = [];
      const deps: SetupDeps = {
        home,
        say: (line) => void said.push(line),
        ask: async () => "y",
        keychain: files(),
        client: () => {
          throw new Error("not contacted");
        },
        sleep: async () => undefined,
        now: () => 1_800_000_000_000,
        code: () => "KONFAB-ABCDE-23456",
      };
      typed = [TOKEN];
      expect(await tokenOnly(deps, "ABC234")).toBe(true);
      expect(readNotes(home)).toMatchObject([
        { state: "ready", code: "ABC234", bot_id: "1234567890" },
      ]);
      status(deps);
      const all = said.join("\n");
      expect(all).toContain("private token folder");
      expect(all).not.toContain("Keychain");
      expect(all).not.toContain(TOKEN.split(":")[1]!);
      expect(readFileSync(join(folder, readNotes(home)[0]!.item), "utf8")).toBe(
        `${TOKEN}\n`,
      );
    });
  },
);
