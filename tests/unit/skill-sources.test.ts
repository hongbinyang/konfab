import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "tar-stream";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/index.js";
import { SkillSources } from "../../src/server/domain/skill-sources.js";

async function fixture(): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  tar.on("data", (chunk: unknown) =>
    chunks.push(Buffer.from(chunk as Uint8Array)),
  );
  tar.entry(
    { name: "repo/example/SKILL.md" },
    "---\nname: example\ndescription: Cached example\nlicense: MIT\n---\nHello",
  );
  tar.entry({ name: "repo/example/file.txt" }, "data");
  tar.finalize();
  await new Promise<void>((resolve, reject) => {
    tar.on("end", resolve);
    tar.on("error", reject);
  });
  return gzipSync(Buffer.concat(chunks));
}

describe("public skill sources", () => {
  it("does not fetch until asked, pins a cached generation, and refreshes conditionally", async () => {
    const archive = await fixture();
    const calls: { url: string; authorization?: string; etag?: string }[] = [];
    let conditional = false;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization") ?? undefined,
        etag: headers.get("if-none-match") ?? undefined,
      });
      if (url.startsWith("https://api.github.com/")) {
        if (conditional) return new Response(null, { status: 304 });
        return new Response(JSON.stringify({ sha: "a".repeat(40) }), {
          status: 200,
          headers: { etag: '"one"' },
        });
      }
      return new Response(archive, { status: 200 });
    };
    const db = openDatabase(":memory:");
    const sources = new SkillSources(db, {
      fetch: fakeFetch,
      token: "test-token",
    });
    expect(calls).toHaveLength(0);
    const source = sources.list().find((item) => item.owner === "anthropics")!;
    sources.startRefresh(source.id);
    await sources.waitForRefresh();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.authorization).toBeUndefined();
    const browse = sources.browse(source.id);
    expect(browse.skills).toEqual([
      expect.objectContaining({
        name: "example",
        licence: "MIT",
        diagnostic: null,
      }),
    ]);
    const preview = sources.preview(
      source.id,
      browse.generation_id!,
      "example/SKILL.md",
    );
    expect(preview.commit).toBe("a".repeat(40));
    expect(preview.files).toHaveLength(2);

    conditional = true;
    sources.startRefresh(source.id);
    await sources.waitForRefresh();
    expect(calls.at(-1)?.etag).toBe('"one"');
    expect(sources.browse(source.id).generation_id).toBe(browse.generation_id);
    await sources.close();
    db.close();
  });

  it("keeps a token opt-in and never sends it to codeload", async () => {
    const archive = await fixture();
    const auth: (string | null)[] = [];
    const db = openDatabase(":memory:");
    const sources = new SkillSources(db, {
      token: "synthetic-secret",
      fetch: async (input, init) => {
        const url = String(input);
        auth.push(new Headers(init?.headers).get("authorization"));
        return url.startsWith("https://api.github.com/")
          ? new Response(JSON.stringify({ sha: "b".repeat(40) }), {
              status: 200,
            })
          : new Response(archive, { status: 200 });
      },
    });
    sources.setTokenEnabled(true);
    const source = sources.list().find((item) => item.owner === "anthropics")!;
    sources.startRefresh(source.id);
    await sources.waitForRefresh();
    expect(auth).toEqual(["Bearer synthetic-secret", null]);
    expect(JSON.stringify(sources.list())).not.toContain("synthetic-secret");
    await sources.close();
    db.close();
  });

  it("records rate limits without discarding an existing cached generation", async () => {
    const archive = await fixture();
    let limited = false;
    const db = openDatabase(":memory:");
    const sources = new SkillSources(db, {
      fetch: async (input) => {
        if (String(input).startsWith("https://codeload.github.com/"))
          return new Response(archive, { status: 200 });
        if (limited)
          return new Response(null, {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "2000000000",
            },
          });
        return new Response(JSON.stringify({ sha: "c".repeat(40) }), {
          status: 200,
          headers: { etag: '"cached"' },
        });
      },
    });
    const source = sources.list().find((item) => item.owner === "anthropics")!;
    sources.startRefresh(source.id);
    await sources.waitForRefresh();
    const cached = sources.browse(source.id).generation_id;
    limited = true;
    sources.startRefresh(source.id);
    await sources.waitForRefresh();
    const state = sources.list().find((item) => item.id === source.id)!;
    expect(state.current_generation_id).toBe(cached);
    expect(state.rate_limit_reset).toBe(2_000_000_000_000);
    expect(state.latest?.error).toBe("GitHub rate limit reached");
    await sources.close();
    db.close();
  });

  it("reopens a complete cached index without network access", async () => {
    const root = mkdtempSync(join(tmpdir(), "konfab-sources-"));
    const path = join(root, "app.db");
    try {
      const archive = await fixture();
      let db = openDatabase(path);
      let sources = new SkillSources(db, {
        fetch: async (input) =>
          String(input).startsWith("https://api.github.com/")
            ? new Response(JSON.stringify({ sha: "d".repeat(40) }), {
                status: 200,
              })
            : new Response(archive, { status: 200 }),
      });
      const source = sources
        .list()
        .find((item) => item.owner === "anthropics")!;
      sources.startRefresh(source.id);
      await sources.waitForRefresh();
      await sources.close();
      db.close();

      db = openDatabase(path);
      sources = new SkillSources(db, {
        fetch: async () => {
          throw new Error("cached browse must not fetch");
        },
      });
      expect(sources.browse(source.id).skills).toHaveLength(1);
      await sources.close();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
