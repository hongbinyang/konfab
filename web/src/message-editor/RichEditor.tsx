import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { Node as DocNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { RichText } from "../RichText";
import { formats, isActive, type Format } from "./commands";
import {
  compare,
  fromText,
  lostFormats,
  markType,
  safeAddress,
  schema,
  toText,
  type LostFormat,
} from "./convert";
import { createEditor, mac } from "./editor";

export type EditorHandle = {
  focus: () => void;
  insert: (text: string) => void;
  /** Empties the box and returns what was in it. */
  take: () => Draft;
  /** Puts a draft back, before anything written since. */
  putBack: (draft: Draft, placed?: () => void) => void;
  /** False if it isn't time to send, or a review was opened because the message would look different. */
  ready: () => boolean;
};
/** `doc` keeps formats that the text alone can't show. */
export type Draft = { text: string; doc?: DocNode };

type Props = {
  initial: Draft;
  placeholder: string;
  labelId: string;
  onChange: (draft: Draft) => void;
  /** `checked`: the person reviewed the difference and chose to send. */
  onSend: (checked?: boolean) => void;
  onImages: (files: File[]) => void;
  /** More buttons for the row under the box. */
  children?: ReactNode;
  ref?: Ref<EditorHandle>;
};

const shortcut = (key: string) =>
  key
    .replace("Mod-", mac ? "⌘" : "Ctrl+")
    .replace("Shift-", mac ? "⇧" : "Shift+")
    .replace(/.$/, (last) => last.toUpperCase());

const NAMES: Record<string, string> = {
  strong: "bold",
  em: "italic",
  strike: "struck through",
  code: "shown as code",
  link: "a link",
};

const TOOLS = "konfab.formatting-menu";
const PREVIEW = "konfab.message-preview";
/** A choice remembered in this browser. */
function useRemembered(key: string, start: boolean) {
  const [value, setValue] = useState(() => {
    try {
      return (localStorage.getItem(key) ?? (start ? "1" : "0")) === "1";
    } catch {
      return start;
    }
  });
  const change = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Only this visit remembers it.
    }
  };
  return [value, change] as const;
}

/** The rich-text message box. Loaded separately from the page. */
export default function RichEditor({
  initial,
  placeholder,
  labelId,
  onChange,
  onSend,
  onImages,
  children,
  ref,
}: Props) {
  const element = useRef<HTMLDivElement>(null);
  const editor = useRef<ReturnType<typeof createEditor> | null>(null);
  // The editor outlives renders, so it calls whatever the latest props are.
  const latest = useRef({ onChange, onSend, onImages });
  useEffect(() => {
    latest.current = { onChange, onSend, onImages };
  });
  const [active, setActive] = useState<string[]>([]);
  const [text, setText] = useState(initial.text);
  const [difference, setDifference] =
    useState<ReturnType<typeof compare>>("same");
  const [tools, setTools] = useRemembered(TOOLS, false);
  const [preview, setPreview] = useRemembered(PREVIEW, true);
  const [help, setHelp] = useState(false);
  const [linking, setLinking] = useState<{
    from: number;
    to: number;
    text: string;
    href: string;
  } | null>(null);
  const [review, setReview] = useState<{
    text: string;
    lost: LostFormat[];
  } | null>(null);

  const openLink = useCallback(() => {
    const view = editor.current?.view;
    if (!view) return;
    const { from, to } = view.state.selection;
    let href = "";
    view.state.doc.nodesBetween(from, to, (node) => {
      href ||=
        (node.marks.find((mark) => mark.type === markType("link"))?.attrs
          .href as string | undefined) ?? "";
    });
    setLinking({
      from,
      to,
      text: view.state.doc.textBetween(from, to),
      href: href || "https://",
    });
  }, []);

  useEffect(() => {
    if (!element.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const state = created.view.state;
      const value = toText(state.doc);
      setActive(
        formats
          .filter((format) => isActive(state, format))
          .map((format) => format.label),
      );
      setText(value);
      latest.current.onChange({ text: value, doc: state.doc });
      clearTimeout(timer);
      timer = setTimeout(
        () => setDifference(compare(created.view.state.doc)),
        150,
      );
    };
    const created = createEditor(element.current, {
      doc: initial.doc ?? fromText(initial.text),
      placeholder,
      labelId,
      onChange: update,
      onSend: () => latest.current.onSend(),
      onLink: openLink,
      onImages: (files) => latest.current.onImages(files),
    });
    editor.current = created;
    update();
    return () => {
      clearTimeout(timer);
      created.view.destroy();
      editor.current = null;
    };
    // The editor keeps its own text; the first values only start it.
  }, []);

  const check = useCallback((): boolean => {
    const view = editor.current?.view;
    if (!view) return true;
    if (view.composing) return false;
    const { doc } = view.state;
    if (compare(doc) !== "differs") return true;
    setReview({ text: toText(doc), lost: lostFormats(doc) });
    return false;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editor.current?.view.focus(),
      insert: (value) => {
        const view = editor.current?.view;
        if (!view) return;
        view.dispatch(view.state.tr.insertText(value).scrollIntoView());
        view.focus();
      },
      take: () => {
        const doc = editor.current?.take();
        return { text: doc ? toText(doc) : "", doc };
      },
      putBack: ({ text: value, doc }, placed) =>
        editor.current?.putBack(doc ?? fromText(value), placed),
      ready: check,
    }),
    [check],
  );

  const run = (format: Format) => {
    const view = editor.current?.view;
    if (!view) return;
    if (!format.run) return openLink();
    format.run(view.state, (change) => view.dispatch(change), view);
    view.focus();
  };

  const moveInToolbar = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(at + step + buttons.length) % buttons.length];
    for (const button of buttons) button.tabIndex = button === next ? 0 : -1;
    next?.focus();
  };

  const closeLink = () => {
    setLinking(null);
    editor.current?.view.focus();
  };

  return (
    <>
      <div
        id="message-formatting"
        className="message-editor-tools"
        role="toolbar"
        aria-label="Formatting"
        hidden={!tools}
        onKeyDown={moveInToolbar}
      >
        {formats.map((format, index) => (
          <button
            key={format.label}
            type="button"
            data-format={format.label}
            tabIndex={index ? -1 : 0}
            aria-label={format.label}
            aria-pressed={
              format.mark || format.block
                ? active.includes(format.label)
                : undefined
            }
            title={`${format.label} (${shortcut(format.key)})`}
            // Keep the text selected.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(format)}
          >
            {format.icon}
          </button>
        ))}
      </div>
      {linking && (
        <LinkForm
          text={linking.text}
          href={linking.href}
          onCancel={closeLink}
          onSave={(value, href) => {
            const view = editor.current?.view;
            if (view) {
              const mark = markType("link").create({ href });
              const change = view.state.tr;
              if (linking.from === linking.to)
                change.replaceWith(
                  linking.from,
                  linking.to,
                  schema.text(value || href, [mark]),
                );
              else change.addMark(linking.from, linking.to, mark);
              view.dispatch(change);
            }
            closeLink();
          }}
          onRemove={() => {
            const view = editor.current?.view;
            view?.dispatch(
              view.state.tr.removeMark(
                linking.from,
                linking.to,
                markType("link"),
              ),
            );
            closeLink();
          }}
        />
      )}
      <div ref={element} className="message-editor-box" />
      <div className="message-editor-note">
        <span role="status">
          {difference === "differs"
            ? "Some formatting can't be sent as shown. Send will show what changes first."
            : difference === "more"
              ? "Markdown you typed will look like this when sent:"
              : ""}
        </span>
        {difference === "more" && (
          <button
            type="button"
            className="quiet"
            aria-expanded={preview}
            onClick={() => setPreview(!preview)}
          >
            {preview ? "Hide" : "Show how it will look"}
          </button>
        )}
      </div>
      {preview && difference === "more" && (
        <div
          className="message-editor-preview"
          role="region"
          aria-label="How it will look when sent"
          tabIndex={0}
        >
          <RichText chat>{text}</RichText>
        </div>
      )}
      <div className="message-editor-row">
        <button
          type="button"
          className="quiet"
          aria-expanded={tools}
          aria-controls="message-formatting"
          onClick={() => setTools(!tools)}
        >
          Formatting menu
        </button>
        <button
          type="button"
          className="quiet"
          aria-expanded={help}
          aria-controls="message-shortcuts"
          onClick={() => setHelp(!help)}
        >
          Shortcuts
        </button>
        {children}
      </div>
      <div id="message-shortcuts" hidden={!help}>
        {help && <Shortcuts />}
      </div>
      {review && (
        <Review
          {...review}
          onEdit={() => {
            setReview(null);
            const view = editor.current?.view;
            const first = review.lost[0];
            if (view && first)
              view.dispatch(
                view.state.tr
                  .setSelection(
                    TextSelection.create(view.state.doc, first.from, first.to),
                  )
                  .scrollIntoView(),
              );
            // After the dialog has given focus back.
            setTimeout(() => view?.focus());
          }}
          onCancel={() => {
            setReview(null);
            setTimeout(() => editor.current?.view.focus());
          }}
          onRemove={() => {
            const view = editor.current?.view;
            setReview(null);
            if (!view) return;
            const change = view.state.tr;
            // Marks can change what is lost next to them, so repeat; each
            // round removes at least one.
            for (
              let lost = review.lost;
              lost.length;
              lost = lostFormats(change.doc)
            )
              for (const { from, to, mark } of lost)
                change.removeMark(from, to, mark);
            view.dispatch(change);
            if (check()) setTimeout(() => view.focus());
          }}
          onSend={() => {
            setReview(null);
            latest.current.onSend(true);
            setTimeout(() => editor.current?.view.focus());
          }}
        />
      )}
    </>
  );
}

function Shortcuts() {
  const rows: [string, string, string][] = [
    ...formats.map((format): [string, string, string] => [
      format.label,
      shortcut(format.key),
      format.typed ?? "",
    ]),
    ["Leave a list or quote at the end", "↓", ""],
    ["Leave bold, code or another format at the end", "→", ""],
    ["Nest a list item", shortcut("Mod-]"), ""],
    ["Un-nest a list item", shortcut("Mod-["), ""],
    ["Undo", shortcut("Mod-z"), ""],
    ["Redo", shortcut("Mod-Shift-z"), ""],
    ["New line in the same list item", mac ? "⇧Enter" : "Shift+Enter", ""],
    ["Send", mac ? "⌘Enter" : "Ctrl+Enter", ""],
  ];
  return (
    <div className="table-scroll">
      <table className="message-shortcuts">
        <caption>Formatting shortcuts</caption>
        <thead>
          <tr>
            <th scope="col">Format</th>
            <th scope="col">Keys</th>
            <th scope="col">Or type</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, keys, typed]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>
                <kbd>{keys}</kbd>
              </td>
              <td>{typed && <code>{typed}</code>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinkForm({
  text,
  href,
  onSave,
  onRemove,
  onCancel,
}: {
  text: string;
  href: string;
  onSave: (text: string, href: string) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(text);
  const [address, setAddress] = useState(href);
  const [error, setError] = useState("");
  const addressRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (text) {
      addressRef.current?.focus();
      addressRef.current?.select();
    } else labelRef.current?.focus();
  }, [text]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (safeAddress(address.trim())) return onSave(label, address.trim());
    setError("Enter an address that starts with https://, http:// or mailto:.");
    addressRef.current?.focus();
  };
  return (
    <form
      className="message-editor-link"
      aria-label="Link"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      {!text && (
        <input
          ref={labelRef}
          aria-label="Link text"
          placeholder="Text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      )}
      <input
        ref={addressRef}
        aria-label="Link address"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "message-link-error" : undefined}
        value={address}
        onChange={(event) => setAddress(event.target.value)}
      />
      <button>Save link</button>
      {text && (
        <button type="button" className="secondary" onClick={onRemove}>
          Remove link
        </button>
      )}
      <button type="button" className="secondary" onClick={onCancel}>
        Cancel
      </button>
      {error && (
        <p id="message-link-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Review({
  text,
  lost,
  onEdit,
  onCancel,
  onRemove,
  onSend,
}: {
  text: string;
  lost: LostFormat[];
  onEdit: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onSend: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    edit.current?.focus();
    return () => {
      if (element?.open) element.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="message-review"
      aria-labelledby="message-review-title"
      onKeyDown={(event) => {
        // Escape only closes this; the page has its own use for it.
        if (event.key === "Escape") event.stopPropagation();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="message-review-title">This will look different when sent</h2>
      <ul>
        {lost.length ? (
          lost.map((item) => (
            <li key={`${item.from}-${item.mark.type.name}`}>
              “{item.text}” won't be {NAMES[item.mark.type.name]}.
            </li>
          ))
        ) : (
          <li>
            Some text changes because of Markdown characters in it. Keep editing
            to change it, or send it as shown here.
          </li>
        )}
      </ul>
      <p>How it will look:</p>
      <div className="message-editor-preview">
        <RichText chat>{text}</RichText>
      </div>
      <div className="message-review-actions">
        <button type="button" className="secondary" onClick={onSend}>
          Send as shown here
        </button>
        {lost.length > 0 && (
          <button type="button" className="secondary" onClick={onRemove}>
            Remove that formatting
          </button>
        )}
        <button type="button" ref={edit} onClick={onEdit}>
          Keep editing
        </button>
      </div>
    </dialog>
  );
}
