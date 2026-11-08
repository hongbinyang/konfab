import { useEffect, useRef, useState, type RefObject } from "react";
import "./emoji-picker.css";

// A small, local set; the operating system renders the Unicode characters.
const groups = {
  Smileys: [
    ["😀", "grinning face"],
    ["😃", "smiling face"],
    ["😊", "blushing smile"],
    ["😂", "tears of joy"],
    ["🤣", "rolling laughing"],
    ["😍", "heart eyes"],
    ["🤔", "thinking"],
    ["😎", "cool"],
    ["😢", "crying"],
    ["😮", "surprised"],
    ["🙃", "upside down"],
    ["🥳", "party"],
    ["🙂", "slight smile"],
    ["😅", "smile sweat"],
    ["😉", "wink"],
    ["😆", "grinning squint"],
    ["😄", "grinning eyes"],
    ["😁", "beaming grin"],
    ["😇", "angel"],
    ["🥰", "smiling hearts"],
    ["😘", "kiss"],
    ["😋", "yummy"],
    ["😛", "tongue"],
    ["😜", "wink tongue"],
    ["🤪", "zany"],
    ["🤗", "hug"],
    ["🤫", "shush"],
    ["🤭", "hand over mouth"],
    ["🫢", "surprised hand mouth"],
    ["🫡", "salute"],
    ["🤨", "raised eyebrow"],
    ["😐", "neutral"],
    ["😑", "expressionless"],
    ["😬", "grimace"],
    ["🙄", "eye roll"],
    ["😏", "smirk"],
    ["😴", "sleeping"],
    ["😷", "mask"],
    ["🤒", "sick"],
    ["🤯", "exploding head"],
    ["😕", "confused"],
    ["😟", "worried"],
    ["🙁", "frown"],
    ["😣", "persevere"],
    ["😭", "sob"],
    ["😤", "triumph"],
    ["😠", "angry"],
    ["😱", "scream"],
    ["🥺", "pleading"],
    ["🤩", "star eyes"],
    ["😌", "relieved"],
    ["🤓", "nerd"],
    ["🫠", "melting"],
  ],
  People: [
    ["👍", "thumbs up"],
    ["👎", "thumbs down"],
    ["👏", "clapping hands"],
    ["🙌", "raised hands"],
    ["👋", "waving hand"],
    ["🤝", "handshake"],
    ["🙏", "folded hands thanks"],
    ["💪", "strong arm"],
    ["👌", "ok hand"],
    ["👀", "eyes"],
    ["🤷", "shrug"],
    ["🤦", "facepalm"],
    ["✋", "raised hand"],
    ["🤚", "back hand"],
    ["🖐️", "hand fingers spread"],
    ["✌️", "victory"],
    ["🤞", "crossed fingers"],
    ["🤟", "love you hand"],
    ["🤘", "rock on"],
    ["🤙", "call me"],
    ["👈", "point left"],
    ["👉", "point right"],
    ["👆", "point up"],
    ["👇", "point down"],
    ["☝️", "index up"],
    ["✍️", "writing hand"],
    ["👊", "fist bump"],
    ["🤜", "right fist"],
    ["🤛", "left fist"],
    ["🫶", "heart hands"],
    ["🧑\u200d💻", "technologist"],
    ["👩\u200d💻", "woman technologist"],
    ["👨\u200d💻", "man technologist"],
    ["🧠", "brain"],
  ],
  Symbols: [
    ["❤️", "red heart"],
    ["💙", "blue heart"],
    ["✨", "sparkles"],
    ["🎉", "celebration"],
    ["🔥", "fire"],
    ["💡", "idea"],
    ["✅", "check mark"],
    ["❌", "cross mark"],
    ["🚀", "rocket"],
    ["⭐", "star"],
    ["⚠️", "warning"],
    ["💯", "hundred"],
    ["🐛", "bug"],
    ["🔧", "wrench"],
    ["📌", "pushpin"],
    ["📝", "memo"],
    ["⏳", "hourglass"],
    ["🎯", "target"],
    ["💻", "laptop"],
    ["📅", "calendar"],
    ["📎", "paperclip"],
    ["📣", "megaphone"],
    ["🔔", "bell"],
    ["🔍", "search"],
    ["🔒", "locked"],
    ["🔓", "unlocked"],
    ["🔑", "key"],
    ["⚙️", "gear"],
    ["🛠️", "tools"],
    ["📊", "bar chart"],
    ["📈", "chart increasing"],
    ["📉", "chart decreasing"],
    ["📋", "clipboard"],
    ["📁", "folder"],
    ["📄", "page"],
    ["📚", "books"],
    ["🔗", "link"],
    ["🧪", "test tube"],
    ["🧹", "broom"],
    ["🚧", "construction"],
    ["🚨", "alert"],
    ["💬", "speech bubble"],
    ["💭", "thought bubble"],
    ["🎁", "gift"],
    ["🏆", "trophy"],
    ["🎈", "balloon"],
    ["🎵", "music"],
    ["💜", "purple heart"],
    ["💚", "green heart"],
    ["💛", "yellow heart"],
    ["🧡", "orange heart"],
    ["🖤", "black heart"],
    ["💔", "broken heart"],
    ["❓", "question"],
    ["❗", "exclamation"],
    ["➕", "plus"],
    ["➖", "minus"],
    ["➡️", "arrow right"],
    ["⬅️", "arrow left"],
    ["⬆️", "arrow up"],
    ["⬇️", "arrow down"],
    ["♻️", "recycle"],
    ["⌛", "hourglass done"],
    ["⏰", "alarm clock"],
  ],
  Nature: [
    ["🌞", "sun"],
    ["🌈", "rainbow"],
    ["🌱", "seedling"],
    ["🌻", "sunflower"],
    ["🌍", "earth"],
    ["🐈", "cat"],
    ["🐕", "dog"],
    ["🌤️", "sun cloud"],
    ["☀️", "sunshine"],
    ["☁️", "cloud"],
    ["🌧️", "rain"],
    ["❄️", "snow"],
    ["🌙", "moon"],
    ["🌟", "glowing star"],
    ["🌲", "evergreen tree"],
    ["🌳", "tree"],
    ["🌸", "cherry blossom"],
    ["🌷", "tulip"],
    ["🌼", "blossom"],
    ["🍀", "clover"],
    ["🍃", "leaves"],
    ["🐝", "bee"],
    ["🦋", "butterfly"],
    ["🐦", "bird"],
    ["🐢", "turtle"],
    ["🐙", "octopus"],
    ["🐳", "whale"],
  ],
} satisfies Record<string, [string, string][]>;

type Category = keyof typeof groups;

export function EmojiPicker({
  textarea,
  onInsert,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  onInsert: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>("Smileys");
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const entries = query.trim()
    ? Object.values(groups)
        .flat()
        .filter(([, name]) =>
          name.toLowerCase().includes(query.trim().toLowerCase()),
        )
    : groups[category];

  function insert(emoji: string) {
    const input = textarea.current;
    if (!input) return;
    input.focus();
    // insertText participates in the browser's native undo history.
    if (!document.execCommand("insertText", false, emoji)) {
      input.setRangeText(
        emoji,
        input.selectionStart,
        input.selectionEnd,
        "end",
      );
    }
    onInsert(input.value);
    setOpen(false);
  }

  return (
    <div className="emoji-picker" ref={root}>
      <button
        type="button"
        ref={trigger}
        aria-label="Choose emoji"
        aria-expanded={open}
        aria-controls={open ? "emoji-panel" : undefined}
        onClick={() => setOpen(!open)}
      >
        😊
      </button>
      {open && (
        <div
          id="emoji-panel"
          className="emoji-panel"
          role="dialog"
          aria-label="Choose emoji"
        >
          <label className="emoji-search">
            Search emoji
            <input
              ref={search}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div
            className="emoji-categories"
            role="group"
            aria-label="Emoji categories"
          >
            {(Object.keys(groups) as Category[]).map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={item === category && !query}
                onClick={() => {
                  setCategory(item);
                  setQuery("");
                }}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="emoji-grid">
            {entries.map(([emoji, name]) => (
              <button
                type="button"
                key={name}
                aria-label={name}
                title={name}
                onClick={() => insert(emoji)}
              >
                {emoji}
              </button>
            ))}
            {entries.length === 0 && <p>No emoji found.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
