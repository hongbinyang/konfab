import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  freePort,
  SYNTHETIC_GITHUB_TOKEN,
  startKonfab,
} from "../e2e/konfab-server.js";

describe("browser test server fixture", () => {
  it("starts an isolated server with a synthetic token and cleans up", async () => {
    const server = await startKonfab();
    try {
      expect(server.env.KONFAB_GITHUB_TOKEN).toBe(SYNTHETIC_GITHUB_TOKEN);
      expect(server.env.HOME?.startsWith(server.root)).toBe(true);
      expect(server.env.KONFAB_HOME?.startsWith(server.root)).toBe(true);
      expect((await fetch(`${server.baseUrl}/`)).ok).toBe(true);
    } finally {
      server.stop();
    }
    expect(existsSync(server.root)).toBe(false);
    await expect(fetch(`${server.baseUrl}/`)).rejects.toThrow();
  });

  it("refuses a port another service already answers on", async () => {
    const port = await freePort();
    const impostor: Server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Konfab</title>");
    });
    await new Promise<void>((resolve) =>
      impostor.listen(port, "127.0.0.1", resolve),
    );
    const fixtures = () =>
      readdirSync(tmpdir()).filter((name) => name.startsWith("konfab-e2e-"));
    const before = new Set(fixtures());
    try {
      await expect(startKonfab({ port, timeoutMs: 10_000 })).rejects.toThrow(
        /exited before it was ready|did not answer/,
      );
      expect(fixtures().filter((name) => !before.has(name))).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => impostor.close(() => resolve()));
    }
  });
});
