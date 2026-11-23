import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentType,
  type Ref,
} from "react";
import type RichEditorType from "./RichEditor";
import type { Draft, EditorHandle } from "./RichEditor";
import "./message-editor.css";

const STORED = "konfab.plain-text-box";
const storedPlain = () => {
  try {
    return localStorage.getItem(STORED) === "1";
  } catch {
    return false;
  }
};

type RichComponent = ComponentType<Parameters<typeof RichEditorType>[0]>;
/** Once loaded, the next room opens with it at once. */
let loadedRich: RichComponent | null = null;

/**
 * The message box: rich text, or today's plain box if it was chosen, until
 * the rich one has loaded, or if it can't load. The text is always a plain
 * string, so switching never loses or changes it.
 */
export function MessageInput({
  draft,
  placeholder,
  labelId,
  onChange,
  onUnplaced,
  onSend,
  onImages,
  ref,
}: {
  draft: Draft;
  placeholder: string;
  labelId: string;
  onChange: (draft: Draft) => void;
  /** A draft that was being put back when the box went away. */
  onUnplaced: (draft: Draft) => void;
  onSend: (checked?: boolean) => void;
  onImages: (files: File[]) => void;
  ref?: Ref<EditorHandle>;
}) {
  const [wantsPlain, setWantsPlain] = useState(storedPlain);
  const value = draft.text;
  const [Rich, setRich] = useState<RichComponent | null>(() => loadedRich);
  const [failed, setFailed] = useState(false);
  // Once the plain box has text, it stays until that text is sent or the
  // person switches, so the box never changes while someone is typing.
  const [swap, setSwap] = useState(() => Boolean(loadedRich));
  const textarea = useRef<HTMLTextAreaElement>(null);
  const rich = useRef<EditorHandle>(null);
  const composing = useRef(false);

  useEffect(() => {
    if (wantsPlain || Rich) return;
    let current = true;
    import("./RichEditor").then(
      (loaded) => {
        loadedRich = loaded.default;
        if (current) setRich(() => loaded.default);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [wantsPlain, Rich]);

  const showRich = Boolean(Rich) && !wantsPlain && swap;
  if (Rich && !wantsPlain && !swap && !value && !composing.current)
    setSwap(true);

  // Keep the cursor when the rich box replaces the plain one.
  const hadFocus = useRef(false);
  useEffect(() => {
    if (showRich && hadFocus.current) rich.current?.focus();
    hadFocus.current = false;
  }, [showRich]);

  // Waits for a composition to end. Until it is placed, changing or closing
  // the box doesn't lose it.
  const pending = useRef<Draft | null>(null);
  const place = useRef(() => {});
  useEffect(() => {
    place.current = () => {
      const back = pending.current;
      if (!back) return;
      const placed = () => {
        pending.current = null;
      };
      if (showRich) return rich.current?.putBack(back, placed);
      const input = textarea.current;
      if (!input) return;
      const apply = () => {
        if (pending.current !== back || !input.isConnected) return;
        const { value: since, selectionStart, selectionEnd } = input;
        const before = since ? `${back.text}\n` : back.text;
        placed();
        onChange({ text: before + since, doc: since ? undefined : back.doc });
        // After the value is set, keep the cursor where it was in the text.
        setTimeout(() =>
          input.setSelectionRange(
            before.length + selectionStart,
            before.length + selectionEnd,
          ),
        );
      };
      if (composing.current)
        input.addEventListener("compositionend", () => setTimeout(apply), {
          once: true,
        });
      else apply();
    };
  });
  useEffect(() => place.current(), [showRich]);
  const unplaced = useRef(onUnplaced);
  useEffect(() => {
    unplaced.current = onUnplaced;
  });
  useEffect(
    () => () => {
      const back = pending.current;
      pending.current = null;
      // After this box has stopped being the room's.
      if (back) setTimeout(() => unplaced.current(back));
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => (showRich ? rich : textarea).current?.focus(),
      insert: (text) => {
        if (showRich) return rich.current?.insert(text);
        const input = textarea.current;
        if (!input) return;
        input.focus();
        // insertText participates in the browser's native undo history.
        if (!document.execCommand("insertText", false, text))
          input.setRangeText(
            text,
            input.selectionStart,
            input.selectionEnd,
            "end",
          );
        onChange({ text: input.value, doc: undefined });
      },
      take: () => {
        if (showRich && rich.current) return rich.current.take();
        const text = textarea.current?.value ?? "";
        onChange({ text: "", doc: undefined });
        return { text };
      },
      putBack: (back) => {
        pending.current = back;
        place.current();
      },
      ready: () =>
        showRich ? (rich.current?.ready() ?? true) : !composing.current,
    }),
    [showRich, onChange],
  );

  const toggle = () => {
    const plain = !wantsPlain;
    setWantsPlain(plain);
    setSwap(!plain);
    hadFocus.current = !plain;
    try {
      localStorage.setItem(STORED, plain ? "1" : "0");
    } catch {
      // Only this visit remembers it.
    }
    if (plain) setTimeout(() => textarea.current?.focus());
  };

  const mode = (
    <button
      type="button"
      className="quiet message-editor-mode"
      aria-pressed={wantsPlain}
      disabled={failed && !wantsPlain}
      title={
        failed
          ? "The formatting editor couldn't load; reload the page to try again."
          : "Write Markdown yourself, without formatting as you type"
      }
      onClick={toggle}
    >
      Plain text
    </button>
  );

  return (
    <div className={`message-editor${showRich ? " rich" : ""}`}>
      {showRich && Rich ? (
        <Rich
          ref={rich}
          initial={draft}
          placeholder={placeholder}
          labelId={labelId}
          onChange={onChange}
          onSend={onSend}
          onImages={onImages}
        >
          {mode}
        </Rich>
      ) : (
        <textarea
          id="message"
          ref={textarea}
          aria-labelledby={labelId}
          rows={3}
          value={value}
          placeholder={placeholder}
          onFocus={() => {
            hadFocus.current = true;
          }}
          onBlur={() => {
            hadFocus.current = false;
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onChange={(event) =>
            onChange({ text: event.target.value, doc: undefined })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              onSend();
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (files.length) {
              event.preventDefault();
              onImages(files);
            }
          }}
        />
      )}
      {!showRich && <div className="message-editor-row">{mode}</div>}
    </div>
  );
}
