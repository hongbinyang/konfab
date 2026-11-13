import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/server/db/index.js";
import { SkillSources } from "../../src/server/domain/skill-sources.js";
import { SkillLibrary } from "../../src/server/domain/skills.js";

describe("public skill sources", () => {
  it("lists the default sources with the first two enabled, and toggles them", async () => {
    const db = openDatabase(":memory:");
    const sources = new SkillSources(db, {
      fetch: async () => {
        throw new Error("no network expected");
      },
    });
    const listed = sources.list();
    expect(
      listed
        .filter((source) => source.enabled)
        .map((source) => `${source.owner}/${source.repository}`)
        .sort(),
    ).toEqual(["anthropics/skills", "openai/plugins"]);
    const extra = listed.find((source) => source.owner === "obra")!;
    sources.setEnabled(extra.id, true);
    expect(
      sources.list().find((source) => source.id === extra.id)?.enabled,
    ).toBe(1);
    expect(() => sources.setEnabled("missing", true)).toThrow("not found");
    await sources.close();
    db.close();
  });

  it("removes indexes left by earlier versions without touching saved skills", async () => {
    const db = openDatabase(":memory:");
    const sources = new SkillSources(db);
    const source = sources.list()[0]!;
    // An index downloaded by a version that still had indexed browsing.
    db.prepare(
      "INSERT INTO source_generations(id, source_id, commit_id, state, cache_bytes, created_at, last_accessed_at) VALUES ('g1', ?, ?, 'complete', 4096, 0, 0)",
    ).run(source.id, "d".repeat(40));
    db.prepare(
      "INSERT INTO source_cached_packages(generation_id, manifest_path, cache_bytes, last_accessed_at) VALUES ('g1', 'example/SKILL.md', 512, 0)",
    ).run();
    db.prepare(
      "UPDATE skill_sources SET current_generation_id = 'g1' WHERE id = ?",
    ).run(source.id);
    const root = mkdtempSync(join(tmpdir(), "konfab-saved-skill-"));
    const library = new SkillLibrary(db);
    const libraryId = library.registerLibrary("personal", root);
    library.create(libraryId, "saved-skill", "Saved skill");
    const skills = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM skills").get() as { n: number }).n;
    const before = skills();
    expect(sources.legacyIndexSize()).toBe(4608);
    sources.removeLegacyIndexes();
    expect(sources.legacyIndexSize()).toBe(0);
    expect(skills()).toBe(before);
    await sources.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
