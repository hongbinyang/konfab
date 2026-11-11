import { describe, expect, it } from "vitest";
import { GitHubClient } from "../../src/server/domain/github-client.js";

describe("GitHub request budget", () => {
  it("reuses commit, tree and raw manifest responses across ten openings", async () => {
    const calls: string[] = [];
    const client = new GitHubClient(async (input) => {
      calls.push(String(input));
      return new Response("test", {
        headers: {
          etag: '"v1"',
          "x-ratelimit-remaining": "59",
          "x-ratelimit-reset": "9999999999",
        },
      });
    });
    const urls = [
      "https://api.github.com/repos/example/repo/commits/HEAD",
      "https://api.github.com/repos/example/repo/git/trees/abcdef",
      "https://raw.githubusercontent.com/example/repo/abcdef/SKILL.md",
    ];
    for (let i = 0; i < 10; i++)
      for (const url of urls)
        expect(
          await (
            await client.request(url, {}, new AbortController().signal)
          ).text(),
        ).toBe("test");
    expect(calls).toEqual(urls);
  });
  it("revalidates stale entries and retains bodies after 304", async () => {
    let now = 0;
    let calls = 0;
    const client = new GitHubClient(
      async (_url, init) => {
        calls++;
        if (calls === 1)
          return new Response("data", { headers: { etag: '"one"' } });
        expect(new Headers(init?.headers).get("if-none-match")).toBe('"one"');
        return new Response(null, { status: 304 });
      },
      () => now,
    );
    const url = "https://api.github.com/repos/a/b/commits/HEAD";
    await client.request(url, {}, new AbortController().signal);
    now = 3_600_001;
    expect(
      await (
        await client.request(url, {}, new AbortController().signal)
      ).text(),
    ).toBe("data");
    expect(calls).toBe(2);
  });
  it("blocks fresh API calls near exhaustion while keeping cached results", async () => {
    let calls = 0;
    const client = new GitHubClient(async () => {
      calls++;
      return new Response("ok", {
        headers: {
          "x-ratelimit-remaining": "1",
          "x-ratelimit-reset": "9999999999",
        },
      });
    });
    const signal = new AbortController().signal;
    await client.request(
      "https://api.github.com/repos/a/b/commits/HEAD",
      {},
      signal,
    );
    await client.request(
      "https://api.github.com/repos/a/b/commits/HEAD",
      {},
      signal,
    );
    await expect(
      client.request(
        "https://api.github.com/repos/a/b/commits/other",
        {},
        signal,
      ),
    ).rejects.toThrow("GitHub limit");
    expect(calls).toBe(1);
  });
  it("coalesces concurrent requests without one caller cancelling the others", async () => {
    let calls = 0;
    const client = new GitHubClient(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response("shared");
    });
    const url = "https://api.github.com/repos/a/b/commits/HEAD";
    const cancelled = new AbortController();
    const first = client.request(url, {}, cancelled.signal);
    const rest = Array.from({ length: 4 }, () =>
      client.request(url, {}, new AbortController().signal),
    );
    cancelled.abort();
    await expect(first).rejects.toThrow();
    const values = await Promise.all(
      rest.map(async (promise) => (await promise).text()),
    );
    expect(values).toEqual(["shared", "shared", "shared", "shared"]);
    expect(calls).toBe(1);
  });
  it("returns an expired cached response marked stale near exhaustion", async () => {
    let now = 0;
    const client = new GitHubClient(
      async () =>
        new Response("old", {
          headers: {
            "x-ratelimit-remaining": "1",
            "x-ratelimit-reset": "9999999999",
          },
        }),
      () => now,
    );
    const url = "https://api.github.com/repos/a/b/commits/HEAD";
    await client.request(url, {}, new AbortController().signal);
    now = 3_600_001;
    const response = await client.request(
      url,
      {},
      new AbortController().signal,
    );
    expect(response.headers.get("x-konfab-stale")).toBe("1");
    expect(await response.text()).toBe("old");
  });
  it("revalidates an explicit refresh within the hour", async () => {
    let calls = 0;
    const client = new GitHubClient(async () => new Response(String(++calls)));
    const url = "https://api.github.com/repos/a/b/commits/HEAD";
    const signal = new AbortController().signal;
    expect(await (await client.request(url, {}, signal)).text()).toBe("1");
    expect(
      await (
        await client.request(url, {}, signal, { revalidate: true })
      ).text(),
    ).toBe("2");
    expect(calls).toBe(2);
  });
  it("limits concurrent raw requests", async () => {
    let active = 0;
    let peak = 0;
    const client = new GitHubClient(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Response("ok");
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        client.request(
          `https://raw.githubusercontent.com/a/b/sha/${i}`,
          {},
          new AbortController().signal,
        ),
      ),
    );
    expect(peak).toBe(4);
  });
  it("rejects token forwarding and oversized raw manifests", async () => {
    const client = new GitHubClient(
      async () => new Response(new Uint8Array(512 * 1024 + 1)),
    );
    const signal = new AbortController().signal;
    await expect(
      client.request(
        "https://raw.githubusercontent.com/a/b/sha/SKILL.md",
        { Authorization: "Bearer synthetic" },
        signal,
      ),
    ).rejects.toThrow("Credentials");
    await expect(
      client.request(
        "https://raw.githubusercontent.com/a/b/sha/SKILL.md",
        {},
        signal,
      ),
    ).rejects.toThrow("limit");
  });
});
