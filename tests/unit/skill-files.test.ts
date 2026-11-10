import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  packageHash,
  readSkillFiles,
  skillMetadata,
} from "../../src/server/domain/skill-files.js";

describe("skill packages", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "konfab-skill-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it("preserves binary files and hashes changes", () => {
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: test-skill\ndescription: Test\n---\nText",
    );
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "x"), Buffer.from([0, 255]));
    const first = readSkillFiles(root);
    expect(skillMetadata(first)).toEqual({
      name: "test-skill",
      description: "Test",
    });
    expect(first.find((f) => f.path === "assets/x")?.content).toEqual(
      Buffer.from([0, 255]),
    );
    writeFileSync(join(root, "assets", "x"), Buffer.from([1, 255]));
    expect(packageHash(readSkillFiles(root))).not.toBe(packageHash(first));
  });
  it("rejects links", () => {
    symlinkSync("/etc/passwd", join(root, "link"));
    expect(() => readSkillFiles(root)).toThrow();
  });
  it("rejects oversized files and hard links", () => {
    writeFileSync(join(root, "large"), Buffer.alloc(512 * 1024 + 1));
    expect(() => readSkillFiles(root)).toThrow("Oversized");
    rmSync(join(root, "large"));
    writeFileSync(join(root, "original"), "data");
    linkSync(join(root, "original"), join(root, "hardlink"));
    expect(() => readSkillFiles(root)).toThrow();
  });
  it("accepts lower-case Unicode names and rejects malformed names", () => {
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: 技能-一\ndescription: Example\n---\n",
    );
    expect(skillMetadata(readSkillFiles(root)).name).toBe("技能-一");
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: Bad--Name\ndescription: Example\n---\n",
    );
    expect(() => skillMetadata(readSkillFiles(root))).toThrow("name");
  });
  it("bounds empty directories as well as files", () => {
    for (let i = 0; i < 1001; i++) mkdirSync(join(root, `dir-${i}`));
    expect(() => readSkillFiles(root)).toThrow("entry limit");
  });
});
