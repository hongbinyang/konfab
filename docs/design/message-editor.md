# Formatting while writing a message

**Status:** proposal with a working mockup. The lead chose the rich-text editor (option B). Nothing in the app has changed.

## Goal

Formats show in the message box while writing and Markdown marks don't, as in Slack, with a toolbar and shortcuts. What is sent stays Markdown text, so agents, mentions, search, export and old messages work as today.

## How the text is kept

The editor is ProseMirror with a small schema (lines, bulleted and numbered lists, quotes; bold, italic, strikethrough, code, links) and its own converter, because the ready-made Markdown converters rewrote ordinary text.

- **A line that isn't formatted is sent exactly as typed.** Nothing is escaped. Tables, task lists, code blocks and headings typed or pasted as Markdown stay as text in the box and render when sent, as today.
- **Formats add marks** around the text they cover, and nothing else. The one addition is a blank line after a list or quote when a line or another list or quote follows; without it, that line would join the list.
- **Opening text** (from Plain text) shows formats only if writing them back gives exactly the same text. Otherwise every line is shown as it is.
- **The result is checked** with the same parser as sent messages. A short note appears when typed Markdown will also be formatted, or when a format can't be sent as shown (bold directly between punctuation and a letter, such as **foo!**bar). The text is never changed to work around it.
- **Plain text** button: today's box, always available. It is also the fallback while the editor loads or if it fails to load.

## Behaviour

| Format        | Shortcut (Ctrl outside macOS) | Also by typing |
| ------------- | ----------------------------- | -------------- |
| Bold          | ⌘B                            | `**text**`     |
| Italic        | ⌘I                            | `_text_`       |
| Strikethrough | ⌘⇧X                           | `~~text~~`     |
| Inline code   | ⌘E                            | `` `text` ``   |
| Link          | ⌘K                            |                |
| Bulleted list | ⌘⇧8                           | `- `           |
| Numbered list | ⌘⇧7                           | `1. `          |
| Quote         | ⌘⇧9                           | `> `           |
| Nest, un-nest | ⌘], ⌘[                        |                |

- Backspace right after typing one of these restores what was typed. Nothing is converted inside a typed code block.
- Enter adds a line or list item; Enter on an empty item or quote line leaves it. ⌘Enter sends, as today.
- **Paste:** plain text is unchanged. Formatted text keeps only the formats above, and only if no words would be lost; tables and anything else paste as plain text. Links other than http, https and mailto are dropped (the text stays). Images are attached.
- **Copy** gives Markdown as the plain text.
- **Undo** is one step per format or paste.
- **Links:** a small form; Escape cancels and focus returns. Other addresses are refused with a message.
- **Keyboard:** Tab leaves the editor. The toolbar is one tab stop with arrow keys; buttons have names, shortcuts and a pressed state.
- **Drafts, attachments, failed sends:** as today; a failed send keeps both.
- **IME:** the document isn't replaced while a composition is in progress.

## Limits

- The text someone receives can differ from what another editor would write, for example italic is `_x_`, or `*x*` inside a word.
- Tables and task lists aren't edited visually.
- Code blocks aren't a format in the first version.

## Cost

Eight new direct packages (`prosemirror-model`, `state`, `view`, `history`, `keymap`, `commands`, `schema-list`, `inputrules`), all MIT, about 70 KB compressed, loaded separately. The check uses three parser packages that are already installed with the message renderer and would be listed directly.

## Evidence (mockup, Chromium, macOS)

- 60,000 random texts made of Markdown pieces, code, mentions and blank lines: sent and reopened unchanged.
- 20,000 random formatted documents: every format and character the same in the parser used for sent messages.
- 47 checks with real key presses: each format, lists, undo and redo, paste (plain, rich, unsafe link, table, image), copy, links, emoji, attachments, failed sends, IME composition, Tab and toolbar keys, 375 px, page errors.
- Found and fixed while testing: a double click on the empty box put the cursor outside any line.
- Seen only in a test: replacing the whole document in the same instant as an IME commit sometimes left one character. Writing, sending and writing again was right every time.

Not checked: Safari, Firefox, VoiceOver, a real input method, phones, and the real app (its emoji picker, uploads and mention notices).

## Plan

1. Converter and its tests (random texts and documents run in `npm test` with a fixed seed).
2. The editor in the composer, the plain box as fallback, the emoji picker through the editor.
3. Playwright tests in the real app, including uploads, failed sends and mentions; Safari and Firefox engines if they can be installed; VoiceOver and a real input method by hand.
