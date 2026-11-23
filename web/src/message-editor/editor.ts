import { baseKeymap, chainCommands, splitBlock } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { undoInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import {
  DOMParser as DocParser,
  Fragment,
  Slice,
  type Node as DocNode,
} from "prosemirror-model";
import {
  liftListItem,
  sinkListItem,
  splitListItem,
} from "prosemirror-schema-list";
import {
  EditorState,
  Plugin,
  TextSelection,
  type Command,
} from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { backspaceOut, formats, leaveQuote, typingRules } from "./commands";
import { literal, nodeType, plainLines, schema, toText } from "./convert";

const item = nodeType("item");
const paragraph = nodeType("paragraph");
export const mac = /Mac|iPhone|iPad/.test(navigator.platform);

export type EditorOptions = {
  doc: DocNode;
  placeholder: string;
  labelId: string;
  onChange: () => void;
  onSend: () => void;
  onLink: () => void;
  onImages: (files: File[]) => void;
};

const isPlainEmpty = (doc: DocNode) =>
  doc.childCount === 1 &&
  doc.firstChild?.type === paragraph &&
  doc.firstChild.content.size === 0;

/** A double click in the empty box can put the cursor outside any line. */
const keepInLine = new Plugin({
  appendTransaction(_changes, _old, state) {
    const { selection } = state;
    if (
      !(selection instanceof TextSelection) ||
      (selection.$anchor.parent.inlineContent &&
        selection.$head.parent.inlineContent)
    )
      return null;
    return state.tr.setSelection(TextSelection.near(selection.$head, -1));
  },
});

const FORMATTED = "a[href],strong,b,em,i,s,del,code,ul,ol,blockquote";
const KNOWN =
  "a,b,strong,i,em,s,del,code,ul,ol,li,blockquote,p,div,span,br,meta,style,title";
const words = (text: string) =>
  text.replace(/^\s*(?:[•◦▪‣*-]|\d+[.)])\s+/gm, "").replace(/\s/g, "");

/**
 * A pasted page's content, or null if it has something the editor doesn't
 * have (such as a table) or any of its words would be lost.
 */
export function richContent(html: string, text: string): Fragment | null {
  const { body } = new DOMParser().parseFromString(html, "text/html");
  if (
    !body.querySelector(FORMATTED) ||
    ![...body.querySelectorAll("*")].every((node) => node.matches(KNOWN))
  )
    return null;
  for (const hidden of body.querySelectorAll("meta,style,title"))
    hidden.remove();
  // A line break inside a block starts a new line here.
  for (const br of body.querySelectorAll("br")) {
    const block = br.closest("p,div");
    if (!block || block.querySelector("p,div,ul,ol,blockquote")) {
      br.replaceWith("\n");
      continue;
    }
    const range = body.ownerDocument.createRange();
    range.setStartAfter(br);
    range.setEndAfter(block);
    const rest = range.extractContents();
    br.remove();
    block.after(rest);
  }
  const { content } = DocParser.fromSchema(schema).parse(body);
  const pasted = content.textBetween(0, content.size, "\n");
  return words(pasted) === words(text) ? content : null;
}

function paste(
  view: EditorView,
  event: ClipboardEvent,
  copied: { text: string; slice: Slice } | null,
  onImages: (files: File[]) => void,
): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  const images = [...data.files].filter((file) =>
    file.type.startsWith("image/"),
  );
  if (images.length) {
    onImages(images);
    return true;
  }
  const text = data.getData("text/plain").replace(/\r\n?/g, "\n");
  if (!text) return true;
  const { state } = view;
  const { $from, from, to, empty } = state.selection;
  const inCode = $from.marks().some((mark) => mark.type.name === "code");
  /** Joins the first and last lines with the text around them. */
  const joining = (part: Fragment) => {
    const open = (node: DocNode | null) => (node?.type === paragraph ? 1 : 0);
    return new Slice(part, open(part.firstChild), open(part.lastChild));
  };
  if (!inCode && copied?.text === text) {
    const { slice } = copied;
    view.dispatch(
      state.tr
        .replaceSelection(
          slice.openStart || slice.openEnd ? slice : joining(slice.content),
        )
        .scrollIntoView(),
    );
    return true;
  }
  const html = inCode ? "" : data.getData("text/html");
  const content = html ? richContent(html, text) : null;
  if (content) {
    const change = state.tr;
    if (empty && $from.depth === 1 && !$from.parent.content.size) {
      const start = $from.before();
      change.replaceWith(start, $from.after(), content);
      change.setSelection(
        TextSelection.near(change.doc.resolve(start + content.size), -1),
      );
    } else change.replaceRange(from, to, joining(content));
    view.dispatch(change.scrollIntoView());
    return true;
  }
  const lines = plainLines(text, $from.marks());
  view.dispatch(
    state.tr
      .replaceSelection(new Slice(Fragment.from(lines), 1, 1))
      .scrollIntoView(),
  );
  return true;
}

/** The Markdown of a copied part. */
function sliceText(slice: Slice): string {
  try {
    const doc = schema.topNodeType.create(
      null,
      slice.content.firstChild?.isText
        ? paragraph.create(null, slice.content)
        : slice.content,
    );
    doc.check();
    return toText(doc);
  } catch {
    return slice.content.textBetween(0, slice.content.size, "\n");
  }
}

export function createEditor(element: HTMLElement, options: EditorOptions) {
  const link: Command = () => {
    options.onLink();
    return true;
  };
  const send: Command = (_state, _dispatch, view) => {
    if (!view?.composing) options.onSend();
    return true;
  };
  const keys: Record<string, Command> = {
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
    "Mod-Enter": send,
    "Mod-]": sinkListItem(item),
    "Mod-[": liftListItem(item),
    Enter: chainCommands(
      splitListItem(item),
      liftListItem(item),
      leaveQuote,
      splitBlock,
    ),
    "Shift-Enter": splitBlock,
    Backspace: chainCommands(undoInputRule, backspaceOut),
  };
  for (const { key, run } of formats) keys[key] = run ?? link;
  // With Shift, a digit key reports the symbol printed on it.
  const digits = new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (!(mac ? event.metaKey : event.ctrlKey) || !event.shiftKey)
          return false;
        const digit = /^Digit([789])$/.exec(event.code)?.[1];
        const run = formats.find(
          ({ key }) => key === `Mod-Shift-${digit}`,
        )?.run;
        if (!digit || !run) return false;
        run(view.state, (change) => view.dispatch(change), view);
        return true;
      },
    },
  });
  const placeholder = new Plugin({
    props: {
      decorations: ({ doc }) =>
        isPlainEmpty(doc) && doc.firstChild
          ? DecorationSet.create(doc, [
              Decoration.node(0, doc.firstChild.nodeSize, {
                class: "message-editor-empty",
                "data-placeholder": options.placeholder,
              }),
            ])
          : null,
    },
  });
  const fresh = (doc: DocNode) =>
    EditorState.create({
      doc,
      plugins: [
        typingRules,
        digits,
        keymap(keys),
        keymap(baseKeymap),
        history(),
        placeholder,
        keepInLine,
      ],
    });
  let copied: { text: string; slice: Slice } | null = null;
  const view: EditorView = new EditorView(element, {
    state: fresh(options.doc),
    attributes: {
      id: "message",
      class: "message-editor-text",
      role: "textbox",
      "aria-labelledby": options.labelId,
      "aria-multiline": "true",
      "aria-placeholder": options.placeholder,
      spellcheck: "true",
    },
    clipboardTextSerializer(slice) {
      const text = sliceText(slice);
      copied = { text, slice };
      return text;
    },
    handlePaste: (current, event) =>
      paste(current, event, copied, options.onImages),
    handleDrop(current, event, _slice, moved) {
      if (moved) return false;
      // Files are attached by the composer. Anything else drops as plain text.
      if (event.dataTransfer?.files.length) return true;
      const text = event.dataTransfer
        ?.getData("text/plain")
        .replace(/\r\n?/g, "\n");
      const at = current.posAtCoords({
        left: event.clientX,
        top: event.clientY,
      });
      if (text && at) {
        const change = current.state.tr;
        change.setSelection(TextSelection.near(change.doc.resolve(at.pos)));
        change.replaceSelection(
          new Slice(Fragment.from(plainLines(text)), 1, 1),
        );
        current.dispatch(change);
      }
      return true;
    },
    dispatchTransaction(change) {
      view.updateState(view.state.apply(change));
      options.onChange();
    },
  });
  /** Now, or once the current composition has ended. */
  const whenSettled = (apply: () => void) => {
    const run = () => {
      if (!view.isDestroyed) apply();
    };
    if (view.composing)
      view.dom.addEventListener("compositionend", () => setTimeout(run, 60), {
        once: true,
      });
    else run();
  };
  return {
    view,
    /** Empties the box and its undo history, and returns what was in it. */
    take(): DocNode {
      const { doc } = view.state;
      view.updateState(fresh(literal("")));
      options.onChange();
      return doc;
    },
    /** Puts a draft back, before anything written since. */
    putBack(doc: DocNode) {
      whenSettled(() => {
        const { state } = view;
        const change = state.tr.setMeta("addToHistory", false);
        if (isPlainEmpty(state.doc)) {
          change.replaceWith(0, state.doc.content.size, doc.content);
          change.setSelection(TextSelection.atEnd(change.doc));
        } else change.insert(0, doc.content);
        view.dispatch(change);
      });
    },
  };
}
