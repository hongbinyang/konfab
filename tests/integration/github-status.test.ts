import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { openDatabase } from "../../src/server/db/index.js";
import { KonfabService } from "../../src/server/domain/service.js";
import { SkillSources } from "../../src/server/domain/skill-sources.js";
import { buildApp } from "../../src/server/api/app.js";

describe("GitHub status", () => {
  it("reports public, accepted and rejected tokens without exposing credentials or falling back", async () => {
    const db = openDatabase(":memory:");
    const secret = "synthetic-secret-token";
    let status = 200;
    let fail = false;
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const sources = new SkillSources(db, {
      token: secret,
      now: () => 1_000_000,
      fetch: async (url, init) => {
        const authorization = new Headers(init?.headers).get("authorization");
        requests.push({ url: String(url), authorization });
        if (fail) throw new Error(`sensitive: ${secret}`);
        return new Response("{}", {
          status,
          headers: {
            "x-ratelimit-limit": authorization ? "5000" : "60",
            "x-ratelimit-remaining": authorization ? "4982" : "51",
            "x-ratelimit-reset": "2000000000",
          },
        });
      },
    });
    const service = new KonfabService(db, {
      waitTimeoutSeconds: 1,
      turnTimeoutMs: 60000,
      maxMessageChars: 1000,
    });
    let logs = "";
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logs += String(chunk);
        callback();
      },
    });
    const app = await buildApp({
      service,
      sources,
      port: 19794,
      logger: true,
      logStream,
    });
    try {
      const host = "127.0.0.1:19794";
      const login = await app.inject({
        method: "GET",
        url: `/login?code=${service.createLoginCode()}`,
        headers: { host },
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const call = (
        method: "GET" | "POST" | "PUT",
        url: string,
        payload?: object,
      ) =>
        app.inject({
          method,
          url,
          headers: { host, cookie },
          ...(payload ? { payload } : {}),
        });
      let response = await call("POST", "/api/library/github-status/check");
      expect(response.json()).toMatchObject({
        mode: "public",
        state: "accepted",
        limit: 60,
        remaining: 51,
      });
      expect(requests.at(-1)).toEqual({
        url: "https://api.github.com/rate_limit",
        authorization: null,
      });
      expect(
        (
          await call("PUT", "/api/library/source-token", {
            enabled: true,
            acknowledged: true,
          })
        ).statusCode,
      ).toBe(200);
      response = await call("POST", "/api/library/github-status/check");
      expect(response.json()).toMatchObject({
        mode: "token",
        state: "accepted",
        limit: 5000,
        remaining: 4982,
        reset_at: 2000000000000,
      });
      expect(requests.at(-1)?.authorization).toBe(`Bearer ${secret}`);
      expect(response.body).not.toContain(secret);
      expect((await call("GET", "/api/library/sources")).body).not.toContain(
        secret,
      );
      status = 401;
      const before = requests.length;
      response = await call("POST", "/api/library/github-status/check");
      expect(response.json()).toMatchObject({
        mode: "token",
        state: "rejected",
      });
      expect(requests).toHaveLength(before + 1);
      expect(requests.at(-1)?.authorization).toBe(`Bearer ${secret}`);
      expect(response.body).not.toContain(secret);
      fail = true;
      response = await call("POST", "/api/library/github-status/check");
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain(secret);
      expect(logs).not.toContain(secret);
    } finally {
      await app.close();
      await sources.close();
      db.close();
    }
  });
});
