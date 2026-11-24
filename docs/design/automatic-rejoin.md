# Automatic rejoin

**Status:** feasibility findings (2026-11-23, macOS, Codex CLI 0.171.0-alpha.13 from the ChatGPT app, Claude Code 2.1.220). Built since as the [Rejoin agents button](rejoin-agents.md). Copying the rejoin prompt stays in any case.

| Question                                                  | Codex                                                                                                                                                                                                                          | Claude Code                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Can Konfab learn which conversation an agent is in?       | Yes, observed from the CLI: each tool call carries `threadId`                                                                                                                                                                  | Yes, observed in the desktop app: the connector's environment has the conversation's id                                      |
| Can a message be added to that conversation from outside? | Yes, observed: `codex exec resume <id>` answered in the same conversation, run by the CLI, not the app                                                                                                                         | `claude --resume <id> -p` exists; not tested (the CLI here has no credit)                                                    |
| Can the desktop app itself be made to continue it?        | Yes, observed once, when the app has the conversation loaded: `codex queue` from outside, and the app ran the turn and answered 6 seconds later. A conversation that isn't loaded kept its message waiting (10 minutes so far) | Unknown. The app contains `claude://code/new` and `claude://code/continue?session=last`; not opened, and neither takes an id |
| Can it be opened in the app from outside?                 | `codex://threads/<id>` opened it (by the lead); opening a second one delivered the message that had been waiting about 12 minutes, and the app answered it (observed once)                                                     | Unknown                                                                                                                      |

**Correction.** An earlier version of this note said a queued message wasn't delivered when the CLI resumed the conversation. The conversation's own record shows it was: the message and the CLI's prompt were put into one turn, and only the prompt was answered. My check had looked for the wrong text.

The observed turn used the conversation's own approval settings; nothing was changed. The record's only open file handle belonged to the app's own server, and no CLI was run other than `codex queue`, so the app did the work.

A CLI can also continue a Codex conversation (`codex exec resume`), but then the agent works outside the app the lead sees. Konfab shouldn't use that.

## The end-to-end test so far (temporary Konfab, real connector off, the app's own server program)

| Step                                                                    | Result                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A conversation joins a room through the real connector code and replies | Worked: joined in 6 seconds, replied in 4                                            |
| The turn is interrupted, then Konfab's rejoin prompt is queued          | **Not delivered** in 45 seconds                                                      |
| A normal turn ended by itself, then a message is queued                 | Delivered 7 seconds after queueing (small check with no Konfab)                      |
| A turn interrupted, then a message is queued                            | Not delivered in 15 seconds; delivered after the next normal turn ended (same check) |

| **An agent that ended its turn when the lead told it to: rejoin prompt queued, conversation loaded** | **Rejoined.** The same conversation started 1 second later, opened a new Konfab session, and answered a message in the room |
| **The same, with the app closed: queued, app started, conversation then loaded** | **Rejoined.** Nothing until the conversation was loaded, then at once; one new session, and it answered |

So a queued message waits when the conversation's last turn was **interrupted** (Stop pressed). That is the usual way an agent is stopped, and Konfab can't tell it from outside, so a button could leave a prompt waiting without saying why, to be delivered by some later message. A conversation whose agent simply ended its turn looks fine. After a usage limit or a crash: not tested.

The rejoin itself is proven once for each of the two last rows, with the server program the app uses. With the app's own window, only message delivery was seen, not a rejoin.

## In the apps' own windows (2026-11-23, with the lead)

| App                                                                                   | Result                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex: **Rejoin** selected, conversation open, the agent had ended its turn           | **Rejoined**, once: joined after 19 seconds, back 5 seconds later                                                                                                                                                  |
| Claude: a 2-minute background command started by the agent, which then ended its turn | **Started again by itself**, once, 4 seconds after the command ended; the agent joined again without a pasted prompt                                                                                               |
| Claude: a 4-minute command, then **Stop** pressed by the lead while waiting           | **Started again by itself**, once, when the command ended. The agent **didn't join again**: it had been told to stop and wait for the lead, and the wake-up isn't the lead's word. It joined after a pasted prompt |

So Claude has a way that needs the agent's own help in advance: see [a background watcher](rejoin-claude.md). No documented way to send a prompt into an open Claude conversation was found.

## Next tests (need the lead)

1. In the app itself, with a real room (by the lead): from end to end, after Stop, after a usage limit, with a busy or archived conversation, and two requests at once.
2. The same questions for Claude Code's desktop app.

## If it works

An opt-in **Rejoin agents** button per room, beside **Copy rejoin prompt**, which always stays. It sends only the rejoin prompt to the conversation the agent last joined from, changes no approvals, and isn't repeated while one is waiting. An agent counts as back only when it calls `wait_for_turn`; after a time limit its card says so and offers the manual prompt. It never starts by itself.

`codex queue` runs a turn in the person's own conversation, so Konfab would need to be sure of the conversation's id, keep it on this computer, and never queue anything but that prompt.
