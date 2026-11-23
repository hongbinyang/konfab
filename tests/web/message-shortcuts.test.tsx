// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formats } from "../../web/src/message-editor/commands";

describe("the user guide's formatting shortcuts", () => {
  const guide = readFileSync("docs/user-guide.md", "utf8");
  const section = guide.slice(guide.indexOf("### Formatting shortcuts"));
  const rows = section
    .slice(0, section.indexOf("\n## "))
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .map((line) => line.split("|").map((cell) => cell.trim()));

  it.each(formats.map((format) => [format.label, format] as const))(
    "lists %s as it works in the box",
    (label, format) => {
      const row = rows.find((cells) => cells[1] === label);
      const keys = format.key
        .replace("Mod-", "⌘")
        .replace("Shift-", "⇧")
        .toUpperCase();
      expect(row?.[2]).toBe(keys);
      if (format.typed) expect(row?.[3]).toContain(format.typed.trim());
      else expect(row?.[3]).toBe("");
    },
  );
});
