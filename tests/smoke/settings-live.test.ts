import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { parse } from "yaml";
import { startKonfab, type KonfabServer } from "../e2e/konfab-server.js";

/** The built server, changed while it runs, by every way there is. */
describe.runIf(process.platform === "darwin")(
  "settings of a running server",
  () => {
    let server: KonfabServer;
    let cookie: string;
    let home: string;

    const file = () => readFileSync(join(home, "config.yaml"), "utf8");
    const config = (...args: string[]) =>
      new Promise<{ code: number; out: string }>((done) =>
        execFile(
          "node",
          ["dist/cli/config.js", ...args],
          { env: server.env, encoding: "utf8" },
          (error, stdout) =>
            done({ code: error ? Number(error.code) : 0, out: stdout }),
        ),
      );
    const api = async (method: string, path: string, body?: object) => {
      const answer = await fetch(`${server.baseUrl}${path}`, {
        method,
        headers: {
          cookie,
          origin: server.baseUrl,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: answer.status, body: (await answer.json()) as any };
    };
    const settings = async () => (await api("GET", "/api/settings")).body;
    const value = async (key: string) =>
      (await settings()).settings.find(
        (setting: { key: string }) => setting.key === key,
      );
    const patch = async (set: object) =>
      api("PATCH", "/api/settings", { hash: (await settings()).hash, set });
    const until = async (what: () => Promise<boolean>) => {
      for (let i = 0; i < 80; i += 1) {
        if (await what()) return;
        await new Promise((done) => setTimeout(done, 100));
      }
      throw new Error("It didn't happen in time");
    };
    const write = (sql: string, ...values: unknown[]) => {
      const db = new Database(join(home, "konfab.db"), { timeout: 5000 });
      try {
        return db.prepare(sql).run(...values);
      } finally {
        db.close();
      }
    };
    /** A Codex agent that was here and is away. */
    const away = async () => {
      const room = (
        await api("POST", "/api/rooms", {
          name: "live",
          topic: "",
          members: ["codex"],
        })
      ).body.id as number;
      const now = Date.now();
      write(
        `INSERT INTO sessions (id, room_id, agent_id, state, end_reason, started_at, last_call_at, run_ends_at, conversation_id, route, first_wait_at)
         SELECT ?, id, 'codex', 'ended', 'run_window_ended', ?, ?, ?, ?, 'queue', ? FROM rooms WHERE name = 'live'`,
        randomUUID(),
        now,
        now - 200_000,
        now,
        randomUUID(),
        now,
      );
      return async () =>
        (await api("GET", `/api/rooms/${room}`)).body.agents.find(
          (agent: { id: string }) => agent.id === "codex",
        ).rejoin as {
          offer: string | null;
          request: { state: string } | null;
        } & { room: number };
    };
    const roomId = async () =>
      (await api("GET", "/api/overview")).body.rooms[0].id as number;

    beforeEach(async () => {
      server = await startKonfab();
      home = server.env.KONFAB_HOME!;
      const code = /[?&]code=([^\s&]+)/.exec(
        execFileSync("node", ["dist/cli/login-link.js"], {
          env: server.env,
          encoding: "utf8",
        }),
      )![1];
      const login = await fetch(`${server.baseUrl}/login?code=${code}`, {
        redirect: "manual",
      });
      cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    });
    afterEach(() => server.stop());

    it("takes on the page, the command line and an editor alike, and says so", async () => {
      expect((await patch({ "phone_notices.away_minutes": 3 })).status).toBe(
        200,
      );
      expect((await api("GET", "/api/phone-notices")).body.away_minutes).toBe(
        3,
      );
      expect(
        await config("set", "phone_notices.away_minutes", "4"),
      ).toMatchObject({ code: 0, out: expect.stringContaining("In use.") });
      expect((await api("GET", "/api/phone-notices")).body.away_minutes).toBe(
        4,
      );
      writeFileSync(
        join(home, "config.yaml"),
        file().replace("away_minutes: 4", "away_minutes: 55"),
      );
      await until(
        async () =>
          (await api("GET", "/api/phone-notices")).body.away_minutes === 55,
      );
      const port = new URL(server.baseUrl).port;
      expect(await config("set", "server.port", "9009")).toMatchObject({
        code: 0,
        out: expect.stringContaining(
          `The running Konfab (port ${port}) uses it after a restart.`,
        ),
      });
      expect(await value("server.port")).toMatchObject({
        saved: 9009,
        in_use: Number(port),
      });
      // It still answers where it did.
      expect((await settings()).problem).toBeNull();
      expect(statSync(join(home, "config.yaml")).mode & 0o777).toBe(0o600);
    });

    it("keeps the earlier values with a broken file, and takes the next good one", async () => {
      await patch({ "phone_notices.away_minutes": 3 });
      const good = file();
      writeFileSync(join(home, "config.yaml"), "phone_notices: {\n");
      await until(async () => (await settings()).problem !== null);
      expect((await api("GET", "/api/phone-notices")).body.away_minutes).toBe(
        3,
      );
      expect((await patch({ "phone_notices.away_minutes": 9 })).status).toBe(
        409,
      );
      expect((await config("set", "rejoin.enabled", "false")).code).toBe(1);
      writeFileSync(join(home, "config.yaml"), good.replace(": 3", ": 8"));
      await until(
        async () =>
          (await api("GET", "/api/phone-notices")).body.away_minutes === 8,
      );
    });

    it("turns Rejoin off and on in between, and closes what is open", async () => {
      const rejoin = await away();
      const calls = join(realpathSync(server.root), "codex.calls");
      await until(async () => (await rejoin()).offer === "ready");
      const id = await roomId();
      await api("POST", `/api/rooms/${id}/agents/codex/rejoin`, {});
      await until(async () => (await rejoin()).request?.state === "waiting");
      const sent = readFileSync(calls, "utf8");
      await patch({ "rejoin.enabled": false });
      await until(async () => (await rejoin()).offer === null);
      expect((await rejoin()).request?.state).toBe("closed");
      expect(
        (await api("POST", `/api/rooms/${id}/agents/codex/rejoin`, {})).status,
      ).toBe(409);
      await patch({ "rejoin.enabled": true });
      await until(async () => (await rejoin()).offer === "ready");
      expect(readFileSync(calls, "utf8")).toBe(sent);
    });

    it("runs no other command before the yes, however it was set", async () => {
      const rejoin = await away();
      await until(async () => (await rejoin()).offer === "ready");
      const other = join(realpathSync(server.root), "other");
      writeFileSync(
        other,
        `#!/bin/sh\necho "$1" >> "${other}.ran"\nif [ "$1" = "--version" ]; then echo "codex-cli 0.171.0"; exit 0; fi\nif [ "$2" = "--help" ]; then echo "--thread --message"; exit 0; fi\n`,
        { mode: 0o755 },
      );
      const old = parse(file()).rejoin.codex_command as string;
      writeFileSync(join(home, "config.yaml"), file().replace(old, other));
      await until(async () => (await settings()).command_to_agree === true);
      await until(async () => (await rejoin()).offer === "unavailable");
      // Also on the command line, where nobody can say yes.
      expect((await config("set", "rejoin.codex_command", other)).code).toBe(1);
      execFileSync("node", ["dist/cli/doctor.js"], {
        env: server.env,
        stdio: "ignore",
      });
      expect(existsSync(`${other}.ran`)).toBe(false);
      const look = (
        await api("POST", "/api/settings/codex-command/look", { path: other })
      ).body;
      expect(existsSync(`${other}.ran`)).toBe(false);
      const saved = await api("POST", "/api/settings/codex-command", {
        hash: (await settings()).hash,
        path: other,
        stamp: look.stamp,
      });
      expect(saved.status).toBe(200);
      await until(async () => (await rejoin()).offer === "ready");
      expect(existsSync(`${other}.ran`)).toBe(true);
    });

    it("doesn't take a server that has ended, or of another folder, for this one", async () => {
      const elsewhere = {
        ...server.env,
        KONFAB_HOME: join(server.root, "two"),
      };
      const answer = execFileSync(
        "node",
        ["dist/cli/config.js", "set", "rejoin.wanted_minutes", "7"],
        { env: elsewhere, encoding: "utf8" },
      );
      expect(answer).toContain("Konfab isn't running from this folder");
      expect(file()).not.toContain("wanted_minutes");
    });
  },
);
