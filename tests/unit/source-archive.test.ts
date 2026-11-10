import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { pack, type Header } from "tar-stream";
import { describe, expect, it } from "vitest";
import {
  indexArchive,
  type ArchiveEntry,
  DEFAULT_ARCHIVE_LIMITS,
} from "../../src/server/domain/source-archive.js";

async function archive(
  entries: { header: Partial<Header> & Pick<Header, "name">; body?: string }[],
): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  tar.on("data", (chunk: unknown) => {
    chunks.push(Buffer.from(chunk as Uint8Array));
  });
  for (const item of entries) tar.entry(item.header, item.body ?? "");
  tar.finalize();
  await new Promise<void>((resolve, reject) => {
    tar.on("end", resolve);
    tar.on("error", reject);
  });
  return gzipSync(Buffer.concat(chunks));
}

describe("source archive indexing", () => {
  it("indexes manifests and records skipped links without extracting", async () => {
    const input = await archive([
      {
        header: { name: "root/skill/SKILL.md" },
        body: "---\nname: skill\ndescription: Test\n---\n",
      },
      { header: { name: "root/skill/a.bin" }, body: "hello" },
      {
        header: { name: "root/link", type: "symlink", linkname: "../outside" },
      },
    ]);
    const found: ArchiveEntry[] = [];
    await indexArchive(Readable.from(input), (entry) => found.push(entry));
    expect(found.map((entry) => entry.path)).toEqual([
      "skill/SKILL.md",
      "skill/a.bin",
      "link",
    ]);
    expect(found[0]?.manifest?.toString()).toContain("name: skill");
    expect(found[2]?.kind).toBe("skipped");
  });
  it("rejects traversal, duplicate paths, and expanded size overflow", async () => {
    for (const entries of [
      [{ header: { name: "root/../escape" } }],
      [{ header: { name: "root/file" } }, { header: { name: "root/file" } }],
    ]) {
      await expect(
        indexArchive(Readable.from(await archive(entries)), () => {}),
      ).rejects.toThrow();
    }
    const input = await archive([
      { header: { name: "root/file" }, body: "x".repeat(10_000) },
    ]);
    await expect(
      indexArchive(Readable.from(input), () => {}, {
        ...DEFAULT_ARCHIVE_LIMITS,
        expanded: 1000,
      }),
    ).rejects.toThrow("size limit");
  });
});
