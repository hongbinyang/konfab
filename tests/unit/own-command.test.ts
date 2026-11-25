import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkCommand,
  lookAtCommand,
  sendRejoin,
  type CommandOptions,
} from "../../src/server/rejoin/codex.js";
import {
  agree,
  isAgreed,
  lookAtOwn,
  noteFirst,
} from "../../src/server/rejoin/own-command.js";

const HERE = "019a0000-0000-7000-8000-000000000001";

describe.runIf(process.platform === "darwin")(
  "a command that the lead chose",
  () => {
    let root: string;
    let home: string;
    let command: string;
    let ran: string;
    const standIn = (line = "") =>
      writeFileSync(
        command,
        `#!/bin/sh
echo "$1" >> "${ran}"
if [ "$1" = "--version" ]; then echo "codex-cli 0.171.0"; exit 0; fi
if [ "$2" = "--help" ]; then echo "--thread --message"; exit 0; fi
${line}
`,
        { mode: 0o755 },
      );
    const options = (): CommandOptions => ({
      enabled: true,
      command,
      allowUntested: false,
      agreed: (path, stamp) => isAgreed(home, path, stamp),
      env: { HOME: home },
    });
    const look = () => {
      const seen = lookAtCommand(command);
      if (!seen.ok) throw new Error(seen.reason);
      return { path: seen.path, stamp: seen.stamp };
    };

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "konfab-own-")));
      home = mkdtempSync(join(tmpdir(), "konfab-home-"));
      command = join(root, "codex");
      ran = join(root, "ran");
      // Other tests count what commands leave in the usual one.
      vi.stubEnv("TMPDIR", home);
      standIn();
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    it("isn't run before the yes to exactly this file: not by a look, a check or a send", async () => {
      noteFirst(home, null);
      expect(await lookAtOwn(command, home)).toMatchObject({
        ok: true,
        path: command,
      });
      expect(await checkCommand(options())).toMatchObject({
        ok: false,
        asks: true,
      });
      expect(await sendRejoin(options(), HERE, "X")).toBe("refused");
      expect(existsSync(ran)).toBe(false);
      agree(home, look());
      expect(await checkCommand(options())).toMatchObject({ ok: true });
      expect(existsSync(ran)).toBe(true);
    });

    it("needs another yes when the file has changed, is another one, or the note is unreadable", async () => {
      agree(home, look());
      standIn("# changed");
      chmodSync(command, 0o755);
      rmSync(ran, { force: true });
      expect(await checkCommand(options())).toMatchObject({ asks: true });
      agree(home, { ...look(), path: join(root, "other") });
      expect(await checkCommand(options())).toMatchObject({ asks: true });
      writeFileSync(join(home, "codex-command.json"), "{");
      expect(await checkCommand(options())).toMatchObject({ asks: true });
      expect(await sendRejoin(options(), HERE, "X")).toBe("refused");
      expect(existsSync(ran)).toBe(false);
    });

    it("takes one that was set before as agreed, once", async () => {
      noteFirst(home, command);
      expect(await checkCommand(options())).toMatchObject({ ok: true });
      // A later change isn't taken as agreed at the next start.
      standIn("# changed");
      noteFirst(home, command);
      expect(await checkCommand(options())).toMatchObject({ asks: true });
    });

    it("looks without a shell, and says who signed it only as far as is known", async () => {
      const seen: string[][] = [];
      const run = (stderr: string, code = 0) =>
        (async (path: string, args: string[]) => {
          seen.push([path, ...args]);
          return { started: true, code, complete: true, stdout: "", stderr };
        }) as never;
      expect(
        await lookAtOwn(command, home, run("Authority=Developer ID: A\nx\n")),
      ).toMatchObject({ signed_by: "Developer ID: A" });
      expect(
        await lookAtOwn(command, home, run("Authority=B\n", 1)),
      ).toMatchObject({ ok: true, signed_by: null });
      expect(seen[0]).toEqual([
        "/usr/bin/codesign",
        "-d",
        "--verbose=2",
        command,
      ]);
      expect(existsSync(ran)).toBe(false);
    });

    it.each([
      ["codex", "absolute"],
      ["/nowhere/codex", "can't be found"],
      ["/usr/bin", "isn't a file"],
    ])("refuses %s", async (path, why) => {
      const seen = await lookAtOwn(path, home);
      expect(seen.ok ? "" : seen.reason).toContain(why);
    });

    it("refuses what is in Konfab's own folder, where attachments are", async () => {
      const inside = join(root, "codex");
      expect(await lookAtOwn(inside, root)).toEqual({
        ok: false,
        reason: "it is in Konfab's own folder",
      });
      // Also by a link from elsewhere.
      const link = join(home, "link");
      symlinkSync(inside, link);
      try {
        expect((await lookAtOwn(link, root)).ok).toBe(false);
      } finally {
        rmSync(link);
      }
    });
  },
);
