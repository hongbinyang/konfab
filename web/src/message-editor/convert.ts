import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import {
  Schema,
  type Mark,
  type Node as DocNode,
  type MarkType,
} from "prosemirror-model";
import type { BlockContent, Nodes, PhrasingContent, RootContent } from "mdast";

/**
 * Between the message editor's document and the Markdown text that is sent.
 * A line without formatting is written exactly as typed: nothing is escaped.
 * Only the formats the person applied add marks.
 */
export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "text*",
      parseDOM: [{ tag: "p" }, { tag: "div" }],
      toDOM: () => ["p", 0],
    },
    quote: {
      group: "block",
      content: "(paragraph | bullets | numbers)+",
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0],
    },
    bullets: {
      group: "block",
      content: "item+",
      attrs: { mark: { default: "-" } },
      parseDOM: [{ tag: "ul" }],
      toDOM: () => ["ul", 0],
    },
    numbers: {
      group: "block",
      content: "item+",
      attrs: { start: { default: 1 }, mark: { default: "." } },
      parseDOM: [
        {
          tag: "ol",
          getAttrs: (dom) => ({
            start: Math.max(0, Number(dom.getAttribute("start") ?? 1) || 1),
          }),
        },
      ],
      toDOM: (node) => ["ol", { start: node.attrs.start as number }, 0],
    },
    item: {
      content: "paragraph+ (bullets | numbers)*",
      defining: true,
      parseDOM: [{ tag: "li" }],
      toDOM: () => ["li", 0],
    },
    text: {},
  },
  marks: {
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom) => {
            const href = dom.getAttribute("href") ?? "";
            return safeAddress(href) ? { href } : false;
          },
        },
      ],
      toDOM: (mark) => [
        "a",
        { href: mark.attrs.href as string, title: mark.attrs.href as string },
        0,
      ],
    },
    strong: {
      parseDOM: [
        { tag: "strong" },
        {
          tag: "b",
          // Some pages wrap everything in <b style="font-weight:normal">. The
          // page's content policy stops styles being parsed, so read the text.
          getAttrs: (dom) =>
            /font-weight:\s*(normal|[1-4]00)/i.test(
              dom.getAttribute("style") ?? "",
            )
              ? false
              : null,
        },
      ],
      toDOM: () => ["strong", 0],
    },
    em: {
      parseDOM: [{ tag: "em" }, { tag: "i" }],
      toDOM: () => ["em", 0],
    },
    strike: {
      parseDOM: [{ tag: "s" }, { tag: "del" }],
      toDOM: () => ["s", 0],
    },
    code: {
      excludes: "_",
      parseDOM: [{ tag: "code" }],
      toDOM: () => ["code", { spellcheck: "false" }, 0],
    },
  },
});

/** A node type of the schema above. */
export const nodeType = (name: keyof typeof schema.nodes) => {
  const type = schema.nodes[name];
  if (!type) throw new Error(`No ${name} in the schema`);
  return type;
};
export const markType = (name: keyof typeof schema.marks): MarkType => {
  const type = schema.marks[name];
  if (!type) throw new Error(`No ${name} in the schema`);
  return type;
};

export function safeAddress(value: string): boolean {
  return /^(https?:\/\/|mailto:)\S+$/i.test(value);
}

const ORDER = ["link", "strong", "em", "strike"];
const WORD = /[\p{L}\p{N}_]/u;

function writeInline(line: DocNode): string {
  const pieces: { text: string; marks: readonly Mark[] }[] = [];
  line.forEach((node) =>
    pieces.push({ text: node.text ?? "", marks: node.marks }),
  );
  let out = "";
  const open: { mark: Mark; end: string }[] = [];
  const closeTo = (keep: number) => {
    if (open.length <= keep) return;
    // A format can't end in spaces, so they move outside it.
    const space = /\s*$/.exec(out)?.[0] ?? "";
    out = out.slice(0, out.length - space.length);
    while (open.length > keep) out += open.pop()?.end ?? "";
    out += space;
  };
  pieces.forEach((piece, index) => {
    // The first piece after this one that a format doesn't reach.
    const reach = (mark: Mark) => {
      let end = index;
      while (pieces[end]?.marks.some((other) => other.eq(mark))) end += 1;
      return end;
    };
    const order = (mark: Mark) => ORDER.indexOf(mark.type.name);
    const wanted = piece.marks
      .filter((mark) => order(mark) >= 0)
      // The format that goes on longest is the outer one.
      .sort((a, b) => reach(b) - reach(a) || order(a) - order(b));
    let keep = 0;
    while (
      open[keep] &&
      wanted.some((mark) => mark.eq(open[keep]?.mark as Mark))
    )
      keep += 1;
    closeTo(keep);
    const added = wanted.filter(
      (mark) => !open.some((item) => item.mark.eq(mark)),
    );
    let { text } = piece;
    if (added.length) {
      const lead = /^\s*/.exec(text)?.[0] ?? "";
      out += lead;
      text = text.slice(lead.length);
    }
    if (!text) return;
    for (const mark of added) {
      let start: string;
      let end: string;
      if (mark.type.name === "strong") start = end = "**";
      else if (mark.type.name === "strike") start = end = "~~";
      else if (mark.type.name === "em") {
        // "_" doesn't work inside a word.
        const before = [...out].at(-1) ?? "";
        const after = pieces[reach(mark)]?.text[0] ?? "";
        start = end = WORD.test(before) || WORD.test(after) ? "*" : "_";
      } else {
        const href = mark.attrs.href as string;
        start = "[";
        end = `](${/[\s()<>]/.test(href) ? `<${href.replace(/[<>\n]/g, encodeURIComponent)}>` : href})`;
      }
      out += start;
      open.push({ mark, end });
    }
    if (piece.marks.some((mark) => mark.type.name === "code")) {
      const longest = Math.max(
        0,
        ...(text.match(/`+/g) ?? []).map((ticks) => ticks.length),
      );
      const ticks = "`".repeat(longest + 1);
      const pad =
        /^`|`$/.test(text) || (/^ .* $/.test(text) && text.trim()) ? " " : "";
      out += ticks + pad + text + pad + ticks;
    } else out += text;
  });
  closeTo(0);
  return out;
}

function writeLines(parent: DocNode): string[] {
  const out: string[] = [];
  let before: DocNode | null = null;
  parent.forEach((node) => {
    const name = node.type.name;
    const last = before?.type.name;
    const empty = name === "paragraph" && node.content.size === 0;
    const numbered = name === "numbers" && node.attrs.start !== 1;
    // Without a blank line, this would be read as part of what comes before.
    if (
      last &&
      !empty &&
      (last === "paragraph"
        ? numbered && (before?.content.size ?? 0) > 0
        : name === "paragraph" || name === last || last === "quote" || numbered)
    )
      out.push("");
    if (name === "paragraph") out.push(writeInline(node));
    else if (name === "quote")
      for (const line of writeLines(node)) out.push(line ? `> ${line}` : ">");
    else
      node.forEach((item, _offset, index) => {
        const mark =
          name === "bullets"
            ? `${node.attrs.mark as string} `
            : `${(node.attrs.start as number) + index}${node.attrs.mark as string} `;
        writeLines(item).forEach((line, row) =>
          out.push(
            row === 0 ? mark + line : line && " ".repeat(mark.length) + line,
          ),
        );
      });
    before = node;
  });
  return out;
}

/** The Markdown text to send. */
export const toText = (doc: DocNode): string => writeLines(doc).join("\n");

const parse = (text: string) =>
  fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

const line = (content?: DocNode | DocNode[] | null) =>
  nodeType("paragraph").create(null, content);

/** Lines of plain text, each as it is. */
export const plainLines = (
  text: string,
  marks: readonly Mark[] = [],
): DocNode[] =>
  text.split("\n").map((row) => line(row ? schema.text(row, marks) : null));

export const literal = (text: string): DocNode =>
  schema.node("doc", null, plainLines(text));

const MARKS: Record<string, string> = {
  strong: "strong",
  emphasis: "em",
  delete: "strike",
};

/** Text pieces, with null where a line ends. Throws on what the editor doesn't show. */
function readInline(
  nodes: PhrasingContent[],
  marks: readonly Mark[],
  out: (DocNode | null)[],
): (DocNode | null)[] {
  for (const node of nodes) {
    const name = MARKS[node.type];
    if (node.type === "text")
      node.value.split("\n").forEach((row, index) => {
        if (index) out.push(null);
        if (row) out.push(schema.text(row, marks));
      });
    else if (node.type === "break") out.push(null);
    else if (node.type === "inlineCode")
      out.push(schema.text(node.value, schema.mark("code").addToSet(marks)));
    else if (name && "children" in node)
      readInline(node.children, schema.mark(name).addToSet(marks), out);
    else if (node.type === "link" && !node.title)
      readInline(
        node.children,
        schema.mark("link", { href: node.url }).addToSet(marks),
        out,
      );
    else throw new Error(node.type);
  }
  return out;
}

function readBlocks(nodes: (RootContent | BlockContent)[]): DocNode[] {
  const out: DocNode[] = [];
  let end = 0;
  for (const node of nodes) {
    if (!node.position) throw new Error("no position");
    const last = out.at(-1)?.type.name;
    let gap = out.length ? node.position.start.line - end - 1 : 0;
    if (gap > 0 && last !== "paragraph" && node.type === "paragraph") gap -= 1;
    for (; gap > 0; gap -= 1) out.push(line());
    if (node.type === "paragraph") {
      const rows: DocNode[][] = [[]];
      for (const piece of readInline(node.children, [], []))
        if (piece) rows.at(-1)?.push(piece);
        else rows.push([]);
      out.push(...rows.map((row) => line(row)));
    } else if (node.type === "blockquote")
      out.push(
        schema.node("quote", null, readBlocks(node.children as BlockContent[])),
      );
    else if (node.type === "list") {
      const items = node.children.map((item) => {
        if (item.checked != null) throw new Error("task list");
        return schema.node(
          "item",
          null,
          item.children.length
            ? readBlocks(item.children as BlockContent[])
            : [line()],
        );
      });
      out.push(
        node.ordered
          ? schema.node("numbers", { start: node.start ?? 1 }, items)
          : schema.node("bullets", null, items),
      );
    } else throw new Error(node.type);
    end = node.position.end.line;
  }
  return out;
}

/** Shows formats only if writing them back gives exactly this text. */
export function fromText(text: string): DocNode {
  try {
    const doc = schema.node("doc", null, readBlocks(parse(text).children));
    doc.check();
    if (toText(doc) === text) return doc;
  } catch {
    // It has something the editor doesn't show.
  }
  return literal(text);
}

/** A visible character, the block it is in and its formats. */
type Shown = { char: string; block: string; formats: string[] };
const add = (out: Shown[], text: string, block: string, formats: string[]) => {
  for (const char of text)
    if (!/\s/.test(char)) out.push({ char, block, formats });
};

function shownInEditor(doc: DocNode): Shown[] {
  const out: Shown[] = [];
  const walk = (parent: DocNode, block: string) =>
    parent.forEach((node) => {
      if (node.isText)
        add(
          out,
          node.text ?? "",
          block,
          node.marks.map(
            (mark) => mark.type.name + ((mark.attrs.href as string) ?? ""),
          ),
        );
      else
        walk(
          node,
          node.type.name === "paragraph" ? block : `${block}/${node.type.name}`,
        );
    });
  walk(doc, "");
  return out;
}

function shownWhenSent(text: string): Shown[] {
  const out: Shown[] = [];
  const walk = (nodes: Nodes[], block: string, formats: string[]) => {
    for (const node of nodes) {
      const format = MARKS[node.type];
      if (node.type === "text") add(out, node.value, block, formats);
      else if (node.type === "inlineCode")
        add(out, node.value, block, [...formats, "code"]);
      else if (node.type === "paragraph") walk(node.children, block, formats);
      else if (node.type === "blockquote")
        walk(node.children, `${block}/quote`, formats);
      else if (node.type === "list")
        walk(
          node.children,
          `${block}/${node.ordered ? "numbers" : "bullets"}`,
          formats,
        );
      else if (node.type === "listItem")
        walk(
          node.children,
          `${block}/item${node.checked == null ? "" : "/task"}`,
          formats,
        );
      else if (node.type === "link") {
        // A bare address becomes a link when sent; the editor shows its text.
        // The parser gives some of them, such as e-mail, no position.
        const only = node.children[0];
        const bare =
          !node.position ||
          (node.children.length === 1 &&
            only?.type === "text" &&
            (node.position.end.offset ?? 0) -
              (node.position.start.offset ?? 0) ===
              only.value.length);
        walk(
          node.children,
          block,
          bare ? formats : [...formats, `link${node.url}`],
        );
      } else if ("children" in node)
        walk(
          node.children,
          format ? block : `${block}/${node.type}`,
          format ? [...formats, format] : formats,
        );
      else if ("value" in node)
        add(out, node.value, `${block}/${node.type}`, formats);
    }
  };
  walk(parse(text).children, "", []);
  return out;
}

const sameFormats = (a: Shown, b: Shown) =>
  a.formats.every((name) => b.formats.includes(name));

/**
 * "same": the sent message looks as in the editor. "more": typed Markdown will
 * also be formatted. "differs": a format, or text inside a list, quote or
 * format, would be lost.
 */
export function compare(doc: DocNode): "same" | "more" | "differs" {
  const editor = shownInEditor(doc);
  const sent = shownWhenSent(toText(doc));
  if (
    editor.length === sent.length &&
    editor.every((item, index) => {
      const other = sent[index];
      return (
        other !== undefined &&
        item.char === other.char &&
        item.block === other.block &&
        sameFormats(item, other) &&
        sameFormats(other, item)
      );
    })
  )
    return "same";
  let at = 0;
  for (const item of editor) {
    if (!item.block && !item.formats.length) continue;
    const matches = (other: Shown) =>
      other.char === item.char &&
      other.block.startsWith(item.block) &&
      sameFormats(item, other);
    while (at < sent.length && !matches(sent[at] as Shown)) at += 1;
    if (at >= sent.length) return "differs";
    at += 1;
  }
  return "more";
}

export type LostFormat = { from: number; to: number; mark: Mark; text: string };

/** The formats whose removal would let the message be sent as shown. */
export function lostFormats(doc: DocNode): LostFormat[] {
  const lost: LostFormat[] = [];
  if (compare(doc) !== "differs") return lost;
  const alone = (node: DocNode) => compare(schema.node("doc", null, [node]));
  doc.descendants((row, position) => {
    if (row.type.name !== "paragraph") return true;
    if (alone(row) !== "differs") return false;
    const runs: LostFormat[] = [];
    row.forEach((node, offset) => {
      const from = position + 1 + offset;
      for (const mark of node.marks) {
        const run = runs.findLast(
          (item) => item.mark.eq(mark) && item.to === from,
        );
        if (run) {
          run.to += node.nodeSize;
          run.text += node.text ?? "";
        } else
          runs.push({
            from,
            to: from + node.nodeSize,
            mark,
            text: node.text ?? "",
          });
      }
    });
    const without = (run: LostFormat) => {
      const pieces: DocNode[] = [];
      row.forEach((node, offset) => {
        const at = position + 1 + offset;
        pieces.push(
          at >= run.from && at < run.to
            ? node.mark(run.mark.removeFromSet(node.marks))
            : node,
        );
      });
      return line(pieces);
    };
    const culprit = runs.find((run) => alone(without(run)) !== "differs");
    lost.push(...(culprit ? [culprit] : runs));
    return false;
  });
  return lost;
}
