# Phone notices with the message text

**Status:** a plan for review; nothing is built. The lead chose option A, **on by default** (2026-11-26): a notice carries a short excerpt of what needs them, so that they can read it on the phone while away from the Mac.

## What the lead sees

Today: `Konfab: a room needs you.` With the text:

```
Konfab · settings-room
Codex: @lead the branch is ready for review; two questions: 1. may the…
Claude Code: …
+2 more
```

| Kind                             | Line                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A message that mentions the lead | the agent's name, then its text: whitespace folded, at most **300 characters** (cut at a whole character, with "…") |
| A permission request             | `<agent> asks to send <kind> to <recipient>`                                                                        |
| A room that stopped              | `<room>: <the reason, as the page says it>`                                                                         |

At most **3** lines per notice, grouped under their room's name, then "+N more". The notice stays **one** Telegram message, well under its 4096-character limit; it is sent as plain text (no Markdown or HTML parsing at Telegram).

## Unchanged

How notices are found and sent stays as it is: only while the lead is away; one notice per pass for everything found; per room at most every `room_every_minutes`, at most `max_per_day` a day; quiet hours; each room remembers the highest id sent, so a restart or retry never sends one twice; an answer that may have arrived isn't sent again. Only the words of the notice change.

## The setting

`phone_notices.message_text`, **on by default**, in ⚙ Settings → Phone notices and `npm run config`, in use at once.

- **Turning it on** (after turning it off) asks: "Notices then include up to 300 characters of each message that needs you, with its room and agent. Telegram carries and keeps them; bots aren't end-to-end encrypted. Turn it on?"
- **Turning it off** asks nothing: notices go back to "a room needs you".
- With it on, the room's name is included as well, whatever `room_names` says.
- **Setup says it before it begins**, in the page and in the terminal, instead of today's "Notices never contain message text": "Notices include short excerpts of the messages that need you; you can turn that off in Settings."
- **An existing setup** gets it after the upgrade, as the default; the guide's "what's new" line says so.

## Never sent

- Attachments and files (their names neither), and anything after the 300 characters.
- **Secrets that look like tokens** are replaced by `[hidden]` before sending: Telegram bot tokens, GitHub tokens (`ghp_…`, `github_pat_…`, `gho_…` and the like), Konfab's agent tokens (`kfb_…`), and the bot's and GitHub's tokens in use, whatever their form.

## Tests

With the stand-in Telegram, never the real one:

- the default is on; off gives today's notice word for word;
- one message, three, five ("+2 more"); several rooms; cut at 300 characters with a character of more than one code unit at the edge; whitespace folded;
- a permission request and a stopped room worded as above;
- a token of each form, and the bot's own, in a message: `[hidden]`, never sent;
- the notice is always one message under 4096 characters;
- batching, limits, quiet hours, retries and no repeats after a restart: the existing tests, run with the text on;
- the setting in the page (the question when turning on) and on the command line.

## Documents

The guide (phone notices, the settings table from the list), PN3 in REQUIREMENTS, the setup texts in the page and the terminal, and `docs/handoff.md`.

## Effort

About one working day with review.
