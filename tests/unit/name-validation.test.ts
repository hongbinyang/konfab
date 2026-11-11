import { describe, expect, it } from "vitest";
import { validSkillName } from "../../src/server/domain/skill-files.js";
import { suggestName, validName } from "../../web/src/name-validation.js";

describe("role and skill names", () => {
  it.each([
    "Dev1",
    "two words",
    "-start",
    "end-",
    "double--hyphen",
    "",
    "a".repeat(65),
  ])("rejects %s consistently", (name) => {
    expect(validName(name)).toBe(false);
    expect(validSkillName(name)).toBe(false);
  });
  it.each(["dev1", "konfab-developer", "équipe-１２", "中文"])(
    "accepts %s consistently",
    (name) => {
      expect(validName(name)).toBe(true);
      expect(validSkillName(name)).toBe(true);
    },
  );
  it("suggests a valid name from a title without changing the original", () => {
    const title = "Kconfab Developer";
    expect(suggestName(title)).toBe("kconfab-developer");
    expect(title).toBe("Kconfab Developer");
    expect(suggestName("Dev1")).toBe("dev1");
  });
});
