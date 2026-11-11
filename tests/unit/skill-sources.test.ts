import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pack } from "tar-stream";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/index.js";
import { SkillSources } from "../../src/server/domain/skill-sources.js";
import { SkillLibrary } from "../../src/server/domain/skills.js";

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
  tar.entry({ name: "repo/LICENSE" }, "MIT terms");
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
    let currentTime = 1_000_000;
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
      now: () => currentTime,
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
    expect(sources.browseAll("cached").skills).toEqual([
      expect.objectContaining({
        name: "example",
        owner: "anthropics",
        generation_id: browse.generation_id,
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
    currentTime += 3_600_001;
    sources.startRefresh(source.id);
    await sources.waitForRefresh();
    expect(calls.at(-1)?.etag).toBe('"one"');
    expect(sources.browse(source.id).generation_id).toBe(browse.generation_id);
    await sources.close();
    db.close();
  });

  it("explicit refresh sees a changed commit within the cache hour", async () => {
    const archive = await fixture();
    let revision = "a";
    const db = openDatabase(":memory:");
    const sources = new SkillSources(db, {
      fetch: async (input) =>
        String(input).startsWith("https://api.github.com/")
          ? new Response(JSON.stringify({ sha: revision.repeat(40) }), {
              headers: { etag: `"${revision}"` },
            })
          : new Response(archive),
    });
    const source = sources.list().find((item) => item.owner === "anthropics")!;
    sources.startRefresh(source.id);
    await sources.waitForRefresh();
    expect(sources.browse(source.id).commit).toBe("a".repeat(40));
    revision = "b";
    sources.startRefresh(source.id);
    await sources.waitForRefresh();
    expect(sources.browse(source.id).commit).toBe("b".repeat(40));
    await sources.close();
    db.close();
  });

  it("checks enabled source commits through the shared cache", async () => {
    let calls = 0;
    const db = openDatabase(":memory:");
    const sources = new SkillSources(db, {
      fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ sha: "a".repeat(40) }));
      },
    });
    expect(await sources.latestPublicCommit("anthropics/skills")).toBe(
      "a".repeat(40),
    );
    expect(await sources.latestPublicCommit("anthropics/skills")).toBe(
      "a".repeat(40),
    );
    expect(await sources.latestPublicCommit("missing/source")).toBeNull();
    expect(calls).toBe(1);
    await sources.close();
    db.close();
  });

  it("detects changes to the skill folder rather than unrelated repository commits", async () => {
    const db = openDatabase(":memory:");
    const pinned = "a".repeat(40);
    const latest = "b".repeat(40);
    const latestFolder: string | null = "c".repeat(40);
    const sources = new SkillSources(db, {
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/commits/"))
          return new Response(JSON.stringify({ sha: latest }));
        const folder = url.includes(pinned) ? "c".repeat(40) : latestFolder;
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: folder
              ? [{ path: "skills/report", type: "tree", sha: folder }]
              : [],
          }),
        );
      },
    });
    expect(
      await sources.publicSkillUpdate(
        "anthropics/skills",
        pinned,
        "skills/report/SKILL.md",
      ),
    ).toBe("unchanged");
    await sources.close();
    db.close();
  });
  it.each([
    ["d".repeat(40), "changed"],
    [null, "removed"],
  ] as const)(
    "reports changed or removed skill folders",
    async (latestFolder, expected) => {
      const db = openDatabase(":memory:");
      const pinned = "a".repeat(40);
      const latest = "b".repeat(40);
      const sources = new SkillSources(db, {
        fetch: async (input) => {
          const url = String(input);
          if (url.includes("/commits/"))
            return new Response(JSON.stringify({ sha: latest }));
          const folder = url.includes(pinned) ? "c".repeat(40) : latestFolder;
          return new Response(
            JSON.stringify({
              truncated: false,
              tree: folder
                ? [{ path: "skills/report", type: "tree", sha: folder }]
                : [],
            }),
          );
        },
      });
      expect(
        await sources.publicSkillUpdate(
          "anthropics/skills",
          pinned,
          "skills/report/SKILL.md",
        ),
      ).toBe(expected);
      await sources.close();
      db.close();
    },
  );

  it("removes old source indexes without touching saved skills", async () => {
    const archive = await fixture();
    const db = openDatabase(":memory:");
    const sources = new SkillSources(db, {
      fetch: async (input) =>
        String(input).includes("api.github.com")
          ? new Response(JSON.stringify({ sha: "d".repeat(40) }))
          : new Response(archive),
    });
    const source = sources.list().find((item) => item.owner === "anthropics")!;
    sources.startRefresh(source.id);
    await sources.waitForRefresh();
    expect(sources.browse(source.id).skills.length).toBeGreaterThan(0);
    const root = mkdtempSync(join(tmpdir(), "konfab-saved-skill-"));
    const library = new SkillLibrary(db);
    const libraryId = library.registerLibrary("personal", root);
    library.create(libraryId, "saved-skill", "Saved skill");
    const beforeSkills = (
      db.prepare("SELECT COUNT(*) AS n FROM skills").get() as { n: number }
    ).n;
    expect(sources.legacyIndexSize()).toBeGreaterThan(0);
    sources.removeLegacyIndexes();
    expect(sources.legacyIndexSize()).toBe(0);
    expect(sources.browse(source.id).skills).toHaveLength(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM skills").get() as { n: number }).n,
    ).toBe(beforeSkills);
    await sources.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
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
    let currentTime = 1_000_000;
    const db = openDatabase(":memory:");
    const sources = new SkillSources(db, {
      now: () => currentTime,
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
    currentTime += 3_600_001;
    sources.startRefresh(source.id);
    await sources.waitForRefresh();
    const state = sources.list().find((item) => item.id === source.id)!;
    expect(state.current_generation_id).toBe(cached);
    expect(state.rate_limit_reset).toBe(2_000_000_000_000);
    expect(state.latest?.error).toContain("GitHub rate limit reached");
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

  it("downloads pinned tree blobs, verifies hashes, and keeps the nearest licence", async () => {
    const archive = await fixture();
    const manifest = Buffer.from(
      "---\nname: example\ndescription: Cached example\nlicense: MIT\n---\nHello",
    );
    const extra = Buffer.from("data");
    const license = Buffer.from("MIT terms");
    const blob = (content: Buffer) =>
      createHash("sha1")
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest("hex");
    const blobs = new Map([
      [blob(manifest), manifest],
      [blob(extra), extra],
      [blob(license), license],
    ]);
    let offline = false;
    let apiRequests = 0;
    const db = openDatabase(":memory:");
    const sources = new SkillSources(db, {
      fetch: async (input) => {
        if (offline) throw new Error("offline");
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) apiRequests += 1;
        if (url.includes("/commits/"))
          return new Response(JSON.stringify({ sha: "e".repeat(40) }), {
            status: 200,
          });
        if (url.startsWith("https://codeload.github.com/"))
          return new Response(archive, { status: 200 });
        if (url.includes("/git/trees/"))
          return new Response(
            JSON.stringify({
              truncated: false,
              tree: [
                {
                  path: "example/SKILL.md",
                  mode: "100644",
                  type: "blob",
                  sha: blob(manifest),
                  size: manifest.length,
                },
                {
                  path: "example/file.txt",
                  mode: "100644",
                  type: "blob",
                  sha: blob(extra),
                  size: extra.length,
                },
                {
                  path: "LICENSE",
                  mode: "100644",
                  type: "blob",
                  sha: blob(license),
                  size: license.length,
                },
              ],
            }),
            { status: 200 },
          );
        const sha = url.split("/").at(-1)!;
        const content = blobs.get(sha)!;
        return new Response(
          JSON.stringify({
            encoding: "base64",
            content: content.toString("base64"),
          }),
          { status: 200 },
        );
      },
    });
    const source = sources.list().find((item) => item.owner === "anthropics")!;
    sources.startRefresh(source.id);
    await sources.waitForRefresh();
    const beforeImport = apiRequests;
    const generation = sources.browse(source.id).generation_id!;
    const downloaded = await sources.packageFiles(
      source.id,
      generation,
      "example/SKILL.md",
    );
    expect(downloaded.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "SOURCE-LICENSE",
      "file.txt",
    ]);
    expect(downloaded.provenance).toEqual(
      expect.objectContaining({
        commit: "e".repeat(40),
        licence_path: "LICENSE",
      }),
    );
    expect(apiRequests - beforeImport).toBe(1);
    offline = true;
    expect(
      (
        await sources.packageFiles(source.id, generation, "example/SKILL.md")
      ).files.map((file) => file.path),
    ).toEqual(["SKILL.md", "SOURCE-LICENSE", "file.txt"]);
    await sources.close();
    db.close();
  });
});
