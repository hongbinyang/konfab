import { EditorState } from "prosemirror-state";
import type { Mark, Node as DocNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import {
  compare,
  fromText,
  literal,
  lostFormats,
  nodeType,
  schema,
  toText,
} from "../../web/src/message-editor/convert";

/** Random, but the same on every run. */
function random(seed: number) {
  let state = seed;
  const next = () =>
    (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T,>(items: T[]): T => items[Math.floor(next() * items.length)]!;
  return { next, pick };
}

function randomLine(
  { next, pick }: ReturnType<typeof random>,
  words: string[],
  gap: string,
): DocNode {
  const pieces: DocNode[] = [];
  for (let count = 1 + next() * 4; count > 0; count -= 1) {
    let marks: readonly Mark[] = [];
    if (next() < 0.12) marks = [schema.mark("code")];
    else
      for (const name of ["strong", "em", "strike", "link"])
        if (next() < 0.25)
          marks = schema
            .mark(
              name,
              name === "link"
                ? { href: pick(["https://e.com", "https://e.com/a(b)?q=1&r"]) }
                : null,
            )
            .addToSet(marks);
    if (pieces.length && gap) pieces.push(schema.text(gap));
    pieces.push(schema.text(pick(words), marks));
  }
  return nodeType("paragraph").create(null, pieces);
}

const PIECES = [
  "a",
  "*",
  "**",
  "_",
  "`",
  "```",
  "~~",
  "[x](y)",
  "[room]",
  "| a | b |",
  "|---|---|",
  "- ",
  "* ",
  "1. ",
  "2) ",
  "> ",
  "# ",
  "- [ ] t",
  "- [x] d",
  "\n",
  "\n\n",
  "\n\n\n\n",
  "  ",
  "    ",
  "\t",
  "---",
  "x < y && z",
  "<T>",
  "&amp;",
  "@my_agent",
  "@codex",
  "src/__init__.py",
  "\\",
  "日本",
  "https://e.com/a_b",
  "me@e.com",
  "www.e.com",
  "a*b*c",
];

describe("the message editor's text", () => {
  it("sends any plain text exactly as typed, and reopens any text unchanged", () => {
    const source = random(7);
    let shownFormatted = 0;
    for (let round = 0; round < 4000; round += 1) {
      let text = "";
      for (let count = 1 + source.next() * 10; count > 0; count -= 1)
        text += source.pick(PIECES);
      expect(toText(literal(text))).toBe(text);
      const reopened = fromText(text);
      expect(toText(reopened)).toBe(text);
      if (!reopened.eq(literal(text))) shownFormatted += 1;
      // Any text can be checked.
      compare(reopened);
    }
    expect(shownFormatted).toBeGreaterThan(50);
  });

  it("keeps every format of ordinary words, lists and quotes", () => {
    const source = random(11);
    const words = ["alpha", "beta two", "é", "日本", "@codex", "end.", "a, b"];
    const row = () => randomLine(source, words, " ");
    const item = (depth: number): DocNode =>
      nodeType("item").create(null, [
        row(),
        ...(source.next() < 0.2 ? [row()] : []),
        ...(depth < 2 && source.next() < 0.25 ? [list(depth + 1)] : []),
      ]);
    const list = (depth: number): DocNode => {
      const items: DocNode[] = [];
      for (let count = 1 + source.next() * 3; count > 0; count -= 1)
        items.push(item(depth));
      return source.next() < 0.5
        ? nodeType("bullets").create(null, items)
        : nodeType("numbers").create(
            { start: source.next() < 0.7 ? 1 : 3 },
            items,
          );
    };
    for (let round = 0; round < 1500; round += 1) {
      const blocks: DocNode[] = [];
      for (let count = 1 + source.next() * 4; count > 0; count -= 1) {
        const kind = source.next();
        blocks.push(
          kind < 0.45
            ? row()
            : kind < 0.7
              ? list(0)
              : kind < 0.85
                ? nodeType("quote").create(null, [
                    row(),
                    ...(source.next() < 0.4 ? [list(1)] : []),
                  ])
                : nodeType("paragraph").create(),
        );
      }
      const doc = schema.node("doc", null, blocks);
      const text = toText(doc);
      expect(compare(doc), text).toBe("same");
      expect(toText(fromText(text))).toBe(text);
    }
  });

  it("notices formats that would be lost next to punctuation, and removing them never changes the text", () => {
    const source = random(13);
    const bits = ["a", "b", " ", "!", ")", "(", "*", "_", "`", "~", "[", "]"];
    let noticed = 0;
    for (let round = 0; round < 1500; round += 1) {
      const doc = schema.node("doc", null, [randomLine(source, bits, "")]);
      if (compare(doc) !== "differs") {
        expect(lostFormats(doc)).toEqual([]);
        continue;
      }
      noticed += 1;
      let state = EditorState.create({ doc });
      for (
        let lost = lostFormats(state.doc);
        lost.length;
        lost = lostFormats(state.doc)
      ) {
        const change = state.tr;
        for (const { from, to, mark } of lost)
          change.removeMark(from, to, mark);
        expect(change.docChanged).toBe(true);
        state = state.apply(change);
      }
      expect(state.doc.textContent).toBe(doc.textContent);
    }
    expect(noticed).toBeGreaterThan(200);
  });

  it("names the punctuation case", () => {
    const doc = schema.node("doc", null, [
      nodeType("paragraph").create(null, [
        schema.text("foo!", [schema.mark("strong")]),
        schema.text("bar"),
      ]),
    ]);
    expect(toText(doc)).toBe("**foo!**bar");
    expect(compare(doc)).toBe("differs");
    expect(lostFormats(doc).map((item) => item.text)).toEqual(["foo!"]);
  });

  it.each([
    ["| a | b |\n|---|---|\n| 1 | 2 |", "more"],
    ["- [x] done\n- [ ] open", "more"],
    ["# heading", "more"],
    ["```\ncode\n```", "more"],
    ["x < y && z, array[0] @my_agent src/a_b.py", "same"],
    ["write to me@example.com or www.example.com", "same"],
    ["**b** _i_ ~~s~~ `c` [l](https://e.com)\n- a\n  - b\n1. c\n> q", "same"],
  ])("keeps %j", (text, result) => {
    const doc = fromText(text);
    expect(toText(doc)).toBe(text);
    expect(compare(doc)).toBe(result);
  });

  it("drops a pasted link to anything but a web or mail address", () => {
    expect(
      ["https://e.com", "mailto:a@e.com", "javascript:alert(1)", "data:x"].map(
        (href) => {
          const rule = schema.marks.link?.spec.parseDOM?.[0];
          const element = { getAttribute: () => href } as unknown as string &
            HTMLElement;
          return Boolean(rule?.getAttrs?.(element));
        },
      ),
    ).toEqual([true, true, false, false]);
  });
});
