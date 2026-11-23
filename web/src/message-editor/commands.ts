import { lift, toggleMark, wrapIn } from "prosemirror-commands";
import { InputRule, inputRules } from "prosemirror-inputrules";
import type { MarkType, NodeType, ResolvedPos } from "prosemirror-model";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import {
  EditorState,
  TextSelection,
  type Command,
  type Transaction,
} from "prosemirror-state";
import { markType, nodeType, schema } from "./convert";

const bullets = nodeType("bullets");
const numbers = nodeType("numbers");
const quote = nodeType("quote");
const item = nodeType("item");

/** The depth of the closest block of this type around the cursor, or 0. */
export function depthIn(state: EditorState, type: NodeType): number {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1)
    if ($from.node(depth).type === type) return depth;
  return 0;
}

const toggleList =
  (type: NodeType): Command =>
  (state, dispatch, view) => {
    const other = depthIn(state, type === bullets ? numbers : bullets);
    const same = depthIn(state, type);
    if (same > other) return liftListItem(item)(state, dispatch, view);
    if (!other) return wrapInList(type)(state, dispatch, view);
    dispatch?.(
      state.tr.setNodeMarkup(
        state.selection.$from.before(other),
        type,
        type === bullets ? { mark: "-" } : { start: 1, mark: "." },
      ),
    );
    return true;
  };

const toggleQuote: Command = (state, dispatch, view) =>
  depthIn(state, quote)
    ? lift(state, dispatch, view)
    : wrapIn(quote)(state, dispatch, view);

/** Plain lines again: out of every list and quote, with no formats. */
export const normalText: Command = (state, dispatch) => {
  const change = state.tr;
  const { from, to, empty } = state.selection;
  // Each selected line on its own, so a mix of lists, quotes and lines works.
  const lines: number[] = [];
  state.doc.nodesBetween(from, to, (node, position) => {
    if (node.isTextblock) lines.push(position + 1);
  });
  for (const line of lines)
    for (let round = 0; round < 50; round += 1) {
      const before = EditorState.create({ doc: change.doc });
      const cursor = before.apply(
        before.tr.setSelection(
          TextSelection.create(change.doc, change.mapping.map(line)),
        ),
      );
      if (cursor.selection.$from.depth < 2) break;
      let next: Transaction | undefined;
      const take = (lifted: Transaction) => {
        next = lifted;
      };
      if (!liftListItem(item)(cursor, take)) lift(cursor, take);
      if (!next) break;
      for (const step of next.steps) change.step(step);
    }
  if (!empty)
    change.removeMark(change.mapping.map(from), change.mapping.map(to));
  change.setStoredMarks([]);
  dispatch?.(change.scrollIntoView());
  return true;
};

const atVeryEnd = (state: EditorState): boolean => {
  const { selection, doc } = state;
  return (
    selection.empty &&
    selection.$head.parent.isTextblock &&
    selection.head === TextSelection.atEnd(doc).head
  );
};

/** → at the very end, where the cursor has nowhere to go, leaves the format. */
export const leaveMarks: Command = (state, dispatch) => {
  const marks = state.storedMarks ?? state.selection.$from.marks();
  if (!atVeryEnd(state) || !marks.length) return false;
  dispatch?.(state.tr.setStoredMarks([]));
  return true;
};

/** ↓ at the very end leaves a list or quote for a new plain line. */
export const leaveBlock: Command = (state, dispatch, view) => {
  if (
    !atVeryEnd(state) ||
    state.selection.$head.depth < 2 ||
    (view && !view.endOfTextblock("down"))
  )
    return false;
  if (dispatch) {
    const change = state.tr.insert(
      state.doc.content.size,
      nodeType("paragraph").create(),
    );
    change.setSelection(TextSelection.atEnd(change.doc)).setStoredMarks([]);
    dispatch(change.scrollIntoView());
  }
  return true;
};

/** Enter on an empty later line of an item starts a new item there. */
export const splitBlankLine: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (
    !empty ||
    $from.parent.content.size ||
    $from.depth < 2 ||
    $from.node(-1).type !== item ||
    !$from.index(-1)
  )
    return false;
  dispatch?.(state.tr.split($from.before(), 1).scrollIntoView());
  return true;
};

/** Enter in a list item or quote line with only spaces: as if it were empty. */
export const clearBlank: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const { parent } = $from;
  if (
    !empty ||
    $from.depth < 2 ||
    !parent.content.size ||
    parent.textContent.trim()
  )
    return false;
  dispatch?.(state.tr.delete($from.start(), $from.end()));
  return true;
};

export type Format = {
  label: string;
  key: string;
  icon: string;
  /** What to type for it instead. */
  typed?: string;
  mark?: MarkType;
  block?: NodeType;
  /** Absent for links, which ask for an address first. */
  run?: Command;
};
const markFormat = (
  label: string,
  key: string,
  icon: string,
  name: string,
  typed: string,
): Format => ({
  label,
  key,
  icon,
  typed,
  mark: markType(name),
  run: toggleMark(markType(name)),
});
export const formats: Format[] = [
  markFormat("Bold", "Mod-b", "B", "strong", "**text**"),
  markFormat("Italic", "Mod-i", "I", "em", "_text_"),
  markFormat("Strikethrough", "Mod-Shift-x", "S", "strike", "~~text~~"),
  markFormat("Code", "Mod-e", "</>", "code", "`text`"),
  { label: "Link", key: "Mod-k", icon: "🔗", mark: markType("link") },
  {
    label: "Bulleted list",
    key: "Mod-Shift-8",
    icon: "•≡",
    typed: "- ",
    block: bullets,
    run: toggleList(bullets),
  },
  {
    label: "Numbered list",
    key: "Mod-Shift-7",
    icon: "1≡",
    typed: "1. ",
    block: numbers,
    run: toggleList(numbers),
  },
  {
    label: "Quote",
    key: "Mod-Shift-9",
    icon: "❝",
    typed: "> ",
    block: quote,
    run: toggleQuote,
  },
  {
    label: "Normal text",
    key: "Mod-Shift-0",
    icon: "¶",
    run: normalText,
  },
];

export function isActive(state: EditorState, format: Format): boolean {
  if (format.block) return depthIn(state, format.block) > 0;
  if (!format.mark) return false;
  const { empty, from, to, $from } = state.selection;
  return empty
    ? format.mark.isInSet(state.storedMarks ?? $from.marks()) !== undefined
    : state.doc.rangeHasMark(from, to, format.mark);
}

/** Inside a ``` block typed as text, which is left exactly as typed. */
function inTypedCode($at: ResolvedPos): boolean {
  let fences = 0;
  $at.doc.nodesBetween(0, $at.pos, (node, position) => {
    if (
      node.isTextblock &&
      position + node.nodeSize <= $at.pos &&
      /^\s*```/.test(node.textContent)
    )
      fences += 1;
  });
  return fences % 2 === 1;
}

const markRule = (pattern: RegExp, name: string) =>
  new InputRule(pattern, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    if (inTypedCode($start) || markType("code").isInSet($start.marks()))
      return null;
    const from = start + (match[1]?.length ?? 0);
    const text = match[2] ?? "";
    return state.tr
      .replaceWith(
        from,
        end,
        schema.text(text, [
          ...state.doc.resolve(from).marks(),
          markType(name).create(),
        ]),
      )
      .removeStoredMark(markType(name));
  });

const blockRule = (
  pattern: RegExp,
  wrap: (match: RegExpMatchArray) => Command,
) =>
  new InputRule(pattern, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    if (inTypedCode($start) || depthIn(state, item)) return null;
    const change = state.tr.delete(start, end);
    let wrapped: Transaction | undefined;
    wrap(match)(state.apply(state.tr.delete(start, end)), (next) => {
      wrapped = next;
    });
    if (!wrapped) return null;
    for (const step of wrapped.steps) change.step(step);
    return change;
  });

/** Formats while typing, only where writing it back gives the same text. */
export const typingRules = inputRules({
  rules: [
    blockRule(/^([-*+]) $/, (match) =>
      wrapInList(bullets, { mark: match[1] ?? "-" }),
    ),
    blockRule(/^(\d{1,4})([.)]) $/, (match) =>
      wrapInList(numbers, {
        start: Number(match[1]),
        mark: match[2] ?? ".",
      }),
    ),
    blockRule(/^> $/, () => wrapIn(quote)),
    markRule(/(^|[\s(])\*\*([^\s*](?:[^*]*[^\s*])?)\*\*$/, "strong"),
    markRule(/(^|[\s(])_([^\s_](?:[^_]*[^\s_])?)_$/, "em"),
    markRule(/(^|[\s(])~~([^\s~](?:[^~]*[^\s~])?)~~$/, "strike"),
    markRule(/(^|[\s(])`([^`\s](?:[^`]*[^`\s])?)`$/, "code"),
  ],
});

export const leaveQuote: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  return empty &&
    $from.parent.content.size === 0 &&
    $from.depth > 1 &&
    $from.node(-1).type === quote
    ? lift(state, dispatch, view)
    : false;
};

/** Backspace at the start of a list item or quote takes its line out. */
export const backspaceOut: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset || $from.depth < 2 || $from.index(-1))
    return false;
  if ($from.node(-1).type === item)
    return liftListItem(item)(state, dispatch, view);
  return $from.node(-1).type === quote ? lift(state, dispatch, view) : false;
};
