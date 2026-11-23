import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentType,
  type Ref,
} from "react";
import type RichEditorType from "./RichEditor";
import type { EditorHandle } from "./RichEditor";
import "./message-editor.css";

const STORED = "konfab.plain-text-box";
const storedPlain = () => {
  try {
    return localStorage.getItem(STORED) === "1";
  } catch {
    return false;
  }
};

/**
 * The message box: rich text, or today's plain box if it was chosen, until
 * the rich one has loaded, or if it can't load. The text is always a plain
 * string, so switching never loses or changes it.
 */
export function MessageInput({
  value,
  placeholder,
  labelId,
  onChange,
  onSend,
  onImages,
  ref,
}: {
  value: string;
  placeholder: string;
  labelId: string;
  onChange: (text: string) => void;
  onSend: (checked?: boolean) => void;
  onImages: (files: File[]) => void;
  ref?: Ref<EditorHandle>;
}) {
  const [wantsPlain, setWantsPlain] = useState(storedPlain);
  const [Rich, setRich] = useState<ComponentType<
    Parameters<typeof RichEditorType>[0]
  > | null>(null);
  const [failed, setFailed] = useState(false);
  // Once the plain box has text, it stays until that text is sent or the
  // person switches, so the box never changes while someone is typing.
  const [swap, setSwap] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const rich = useRef<EditorHandle>(null);
  const composing = useRef(false);

  useEffect(() => {
    if (wantsPlain || Rich) return;
    let current = true;
    import("./RichEditor").then(
      (loaded) => {
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
        onChange(input.value);
      },
      clear: () => {
        if (showRich) rich.current?.clear();
        else onChange("");
      },
      ready: () => (showRich ? (rich.current?.ready() ?? true) : true),
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
          initial={value}
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
          onChange={(event) => onChange(event.target.value)}
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
