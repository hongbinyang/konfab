# Phone notices with the message text

**Status:** on main (`f411e33`); tried for real by the lead on 2026-11-27 (a test mention arrived on their iPhone with its excerpt). The lead chose option A, **on by default** (2026-11-26): a notice carries a short excerpt of what needs them, so that they can read it on the phone while away from the Mac.

## Which messages, and when

All as today; only the words of the notice change.

- **Eligible:** an agent's message in a room that mentions `@lead`, that the lead hasn't read in the page while really there, and after which the lead hasn't written in that room. Not in rooms that are archived, paused or on a break, nor while everything is paused.
- **Away:** the timer starts at the lead's last click, key, scroll or touch on the page (a page that is only left open doesn't count); after `away_minutes` (default 10) the lead is away.
- **Gathering:** a notice waits until the oldest of what is found is at least a minute old, so that things close together become one notice.
- **Limits:** per room at most one notice every `room_every_minutes`, at most `max_per_day` a day, nothing in quiet hours. A message that comes while its room waits is in that room's next notice.
- **Several messages:** one notice for everything found in that pass, grouped by room, at most **3 excerpts** in all (the newest first), then "+N more". The ones without an excerpt are counted as told, exactly as today's notice counts everything it covers: they are **not** sent later; the lead reads them in the page.

## What the lead sees

Today: `Konfab: a room needs you.` With the text:

```
Konfab · settings-room
Codex: @lead the branch is ready for review; two questions: 1. may the…
Claude Code: …
+2 more
```

| Kind                                      | Line                                                                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A message that mentions the lead          | the agent's name, then its text: whitespace folded, at most **300 characters**, cut at a whole character as people see it (a grapheme, so an emoji or an accented letter is never split), with "…" |
| A permission request, a room that stopped | **as today**, without details ("a permission request is waiting", "a room has stopped"); their room's name is shown. More detail only if the lead asks for it                                      |

At most **3** excerpts per notice, grouped under their room's name, then "+N more". The notice stays **one** Telegram message, well under its 4096-character limit; it is sent as plain text (no Markdown or HTML parsing at Telegram).

## Unchanged

How notices are found and sent stays as it is: only while the lead is away; one notice per pass for everything found; per room at most every `room_every_minutes`, at most `max_per_day` a day; quiet hours; each room remembers the highest id sent, so a restart or retry never sends one twice; an answer that may have arrived isn't sent again. Only the words of the notice change.

## The setting

`phone_notices.message_text`, **on by default**, in ⚙ Settings → Phone notices and `npm run config`, in use at once.

- **Turning it on** (after turning it off) asks: "Notices then include up to 300 characters of each message that needs you, with its room and agent names. Telegram carries and keeps them; bots aren't end-to-end encrypted. Konfab hides what looks like a token, but can't recognize every secret or personal detail. Turn it on?"
- **Turning it off** asks nothing: notices go back to "a room needs you".
- With it on, the room's name is included as well, whatever `room_names` says.
- **Setup says it before it begins**, in the page and in the terminal, instead of today's "Notices never contain message text": "Notices include short excerpts of the messages that need you; you can turn that off in Settings."
- **An existing setup** gets it after the upgrade, as the default; the guide's "what's new" line says so.

## Retries and restarts

The text is made at the moment of sending, from the database, and is kept nowhere: not in the notice state, a log or an error. Retries and restarts behave as today: what may have arrived isn't sent again, and each room's highest id sent survives a restart, so the same excerpt is never sent twice. A message that was told without an excerpt isn't sent again with one.

## Existing installations and the default

On by default, as the lead chose. A setup made before this version gets it too: the first notice after the upgrade can carry text. The guide's "what's new" says so, and ⚙ Settings → Phone notices shows the switch at the top.

## Never sent

- Attachments and files (their names neither), and anything after the 300 characters.
- **Secrets that look like tokens** are replaced by `[hidden]` before sending. This is **best effort only**: it can't find secrets of other forms or personal data in what an agent wrote, and the question, setup and guide say so. The forms: Telegram bot tokens, GitHub tokens (`ghp_…`, `github_pat_…`, `gho_…` and the like), Konfab's agent tokens (`kfb_…`), and the bot's and GitHub's tokens in use, whatever their form.

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
