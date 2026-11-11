import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { GitHubClient } from "../../src/server/domain/github-client.js";
import { LiveSources } from "../../src/server/domain/live-sources.js";

describe("ephemeral public discovery", () => {
  it("shows path matches first then description matches from the pinned commit", async () => {
    const calls: string[] = [];
    const sha = "a".repeat(40);
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/commits/"))
        return new Response(JSON.stringify({ sha }));
      if (url.includes("/git/trees/"))
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              {
                path: "skills/report/SKILL.md",
                type: "blob",
                mode: "100644",
                sha: "b".repeat(40),
                size: 100,
              },
            ],
          }),
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(
        "---\nname: report\ndescription: Process invoices\nlicense: MIT\n---\nBody",
      );
    };
    const source = {
      id: "source",
      owner: "example",
      repository: "skills",
      ref: "HEAD",
      badge: "community",
      enabled: 1,
    };
    const live = new LiveSources(
      new GitHubClient(fetcher),
      () => [source],
      () => undefined,
    );
    live.search("");
    await vi.waitFor(() => expect(live.search("report").items).toHaveLength(1));
    await vi.waitFor(() =>
      expect(live.search("invoices").items).toHaveLength(1),
    );
    const result = live.search("invoices").items[0]!;
    expect(result.commit).toBe(sha);
    expect((await live.preview(source.id, sha, result.path)).content).toContain(
      "Process invoices",
    );
    expect(calls.filter((url) => url.includes("/commits/"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("/git/trees/"))).toHaveLength(1);
    live.close();
  });
  it("fetches pinned package files and rejects a mismatched preview", async () => {
    const sha = "a".repeat(40);
    const text = "---\nname: report\ndescription: Reporting\n---\nBody";
    const blob = createHash("sha1")
      .update(`blob ${Buffer.byteLength(text)}\0`)
      .update(text)
      .digest("hex");
    const client = new GitHubClient(async (input) => {
      const url = String(input);
      if (url.includes("/commits/"))
        return new Response(JSON.stringify({ sha }));
      if (url.includes("/git/trees/"))
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              {
                path: "report/SKILL.md",
                type: "blob",
                mode: "100644",
                sha: blob,
                size: Buffer.byteLength(text),
              },
            ],
          }),
        );
      return new Response(text);
    });
    const live = new LiveSources(
      client,
      () => [
        {
          id: "source",
          owner: "example",
          repository: "skills",
          ref: "HEAD",
          badge: "community",
          enabled: 1,
        },
      ],
      () => undefined,
    );
    live.search("");
    await vi.waitFor(() =>
      expect(live.search("").sources[0]?.complete).toBe(true),
    );
    const preview = await live.preview("source", sha, "report/SKILL.md");
    const result = await live.packageFiles(
      "source",
      sha,
      "report/SKILL.md",
      preview.preview_hash,
    );
    expect(result.files[0]?.content.toString()).toBe(text);
    await expect(
      live.packageFiles("source", sha, "report/SKILL.md", "0".repeat(64)),
    ).rejects.toThrow("Preview changed");
    live.close();
  });
  it("ranks exact names before description-only matches across sources", async () => {
    const sha = "a".repeat(40);
    const client = new GitHubClient(async (input) => {
      const url = String(input);
      if (url.includes("/commits/"))
        return new Response(JSON.stringify({ sha }));
      if (url.includes("/git/trees/"))
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              {
                path: url.includes("/first/")
                  ? "weak/SKILL.md"
                  : "invoice/SKILL.md",
                type: "blob",
                mode: "100644",
                sha: "b".repeat(40),
                size: 80,
              },
            ],
          }),
        );
      return new Response(
        url.includes("/weak/")
          ? "---\nname: weak\ndescription: invoice workflow\n---\n"
          : "---\nname: invoice\ndescription: reports\n---\n",
      );
    });
    const list = ["first", "second"].map((owner) => ({
      id: owner,
      owner,
      repository: "skills",
      ref: "HEAD",
      badge: "community",
      enabled: 1,
    }));
    const live = new LiveSources(
      client,
      () => list,
      () => undefined,
    );
    live.search("");
    await vi.waitFor(() =>
      expect(live.search("invoice").items).toHaveLength(2),
    );
    expect(live.search("invoice").items.map((item) => item.name)).toEqual([
      "invoice",
      "weak",
    ]);
    live.close();
  });
  it("resumes partial descriptions when the raw-host limit clears", async () => {
    let now = 0;
    let limited = true;
    const sha = "a".repeat(40);
    const client = new GitHubClient(
      async (input) => {
        const url = String(input);
        if (url.includes("/commits/"))
          return new Response(JSON.stringify({ sha }));
        if (url.includes("/git/trees/"))
          return new Response(
            JSON.stringify({
              truncated: false,
              tree: [
                {
                  path: "report/SKILL.md",
                  type: "blob",
                  mode: "100644",
                  sha: "b".repeat(40),
                  size: 80,
                },
              ],
            }),
          );
        if (limited)
          return new Response(null, {
            status: 429,
            headers: { "retry-after": "1" },
          });
        return new Response(
          "---\nname: report\ndescription: Invoice workflow\n---\n",
        );
      },
      () => now,
    );
    const live = new LiveSources(
      client,
      () => [
        {
          id: "source",
          owner: "example",
          repository: "skills",
          ref: "HEAD",
          badge: "community",
          enabled: 1,
        },
      ],
      () => undefined,
      () => now,
    );
    live.search("");
    await vi.waitFor(() =>
      expect(live.search("").sources[0]?.error).toContain("limited"),
    );
    expect(live.search("invoice").items).toHaveLength(0);
    limited = false;
    now = 1001;
    live.search("");
    await vi.waitFor(() =>
      expect(live.search("invoice").items).toHaveLength(1),
    );
    live.close();
  });
  it("identifies an inherited repository licence in the preview", async () => {
    const sha = "a".repeat(40);
    const client = new GitHubClient(async (input) => {
      const url = String(input);
      if (url.includes("/commits/"))
        return new Response(JSON.stringify({ sha }));
      if (url.includes("/git/trees/"))
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              {
                path: "report/SKILL.md",
                type: "blob",
                mode: "100644",
                sha: "b".repeat(40),
                size: 80,
              },
              {
                path: "LICENSE",
                type: "blob",
                mode: "100644",
                sha: "c".repeat(40),
                size: 20,
              },
            ],
          }),
        );
      return new Response("---\nname: report\ndescription: Reporting\n---\n");
    });
    const live = new LiveSources(
      client,
      () => [
        {
          id: "source",
          owner: "example",
          repository: "skills",
          ref: "HEAD",
          badge: "community",
          enabled: 1,
        },
      ],
      () => undefined,
    );
    live.search("");
    await vi.waitFor(() => expect(live.search("").items).toHaveLength(1));
    const preview = await live.preview("source", sha, "report/SKILL.md");
    expect(preview.licence).toContain("SOURCE-LICENSE");
    expect(preview.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "SOURCE-LICENSE" }),
      ]),
    );
    live.close();
  });
  it("reports truncated listings instead of silently omitting results", async () => {
    const sha = "a".repeat(40);
    const client = new GitHubClient(
      async (input) =>
        new Response(
          JSON.stringify(
            String(input).includes("/commits/")
              ? { sha }
              : { tree: [], truncated: true },
          ),
        ),
    );
    const live = new LiveSources(
      client,
      () => [
        {
          id: "source",
          owner: "example",
          repository: "skills",
          ref: "HEAD",
          badge: "community",
          enabled: 1,
        },
      ],
      () => undefined,
    );
    live.search("");
    await vi.waitFor(() =>
      expect(live.search("").sources[0]?.error).toContain("incomplete"),
    );
    live.close();
  });
});
