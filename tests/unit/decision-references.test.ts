import { expect, it } from "vitest";
import { decisionReferences } from "../../web/src/decision-references.js";

it("links known decision IDs while preserving unknown and embedded text", () => {
  const parts = decisionReferences(
    "Replaces #4; see #9 and #99, issue#4 and ##4.",
    [4, 9],
  );
  expect(parts.filter((part) => part.target)).toEqual([
    { text: "#4", target: "4" },
    { text: "#9", target: "9" },
  ]);
  expect(parts.map((part) => part.text).join("")).toBe(
    "Replaces #4; see #9 and #99, issue#4 and ##4.",
  );
});
