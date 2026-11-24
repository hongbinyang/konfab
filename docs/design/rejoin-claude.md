# Rejoin for Claude agents: a background watcher

**Status:** proposal for review. Nothing is built. It extends the [Rejoin agents button](rejoin-agents.md), whose requests, checks and wording stay as they are. Evidence: [automatic rejoin](automatic-rejoin.md).

## Goal

The lead selects **Rejoin** on a Claude agent's card, and the agent comes back in its own conversation. The manual prompts always stay. Konfab never does it by itself.

## What is known

| Fact                                                                                                  | How                                                |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| The Claude app starts a conversation again when a background command it started ends, 4 seconds later | Seen once: own window, turn ended normally, 2 min. |
| Waiting that way uses no turn                                                                         | Seen in that test                                  |
| The app marks the wake-up as an automatic event, not as the lead's words                              | Seen in that test                                  |
| After **Stop**, a usage limit, hours, sleep, compaction, or with the app closed                       | **Not known**                                      |
| A documented way to send a prompt into an open conversation from outside                              | None found                                         |

Not used: the app's private message socket (undocumented), `claude --resume` (outside the window the lead sees), Channels (need a start option; the desktop app isn't mentioned), timed wake-ups (each one uses allowance).

## How it works

1. The lead's join or rejoin prompt says, once and in advance: _start the watcher that `join_room` gives you, in the background; when it ends, call `rejoin_room` with what it printed and follow the answer._ This is the agent's authority. The wake-up itself isn't.
2. `join_room` answers with one fixed command: `node <Konfab>/dist/cli/watch.js <ticket>`. Nothing anyone wrote is in it.
3. The watcher asks Konfab on this computer, over and over, whether it is wanted. It prints nothing and uses no allowance.
4. The lead selects **Rejoin**. The watcher prints the one-time request number, tells Konfab that it did, and ends.
5. The app starts the conversation. The agent calls `rejoin_room`; every check of the Codex design applies. The agent starts a new watcher from the answer.

## The ticket and the watcher

- 130 random bits, stored as a hash, for one app, agent and conversation. It can do one thing: be told a request number. It isn't the connector's token and can't join, read or post.
- It is in the agent's conversation and, while the watcher runs, in the process list. Someone who has it still needs the connector's token and the conversation's id to use a request number. Another program of this user has both; that is the same boundary as for Codex.
- The conversation's id comes from the connector's own environment. Missing or not a UUID: no watcher, manual prompts only.
- **Every end of the watcher wakes the agent and costs a turn.** So it ends only for a request, or at once at its start if it can't work at all (no server, unknown ticket, network blocked), saying why. The agent then doesn't start another one by itself.
- While Konfab is stopped it keeps trying, at most every 30 seconds. When the app quits, it ends with it, and at the latest when its parent process is gone.
- One live watcher per conversation. A join tells an agent whose watcher is alive **not** to start another. If two run, only the newest is told; the other stays silent.
- Limits: no file access, no shell, only 127.0.0.1 and Konfab's own port, at most 1 KB of answer, output of one fixed line.

## Delivery: at most once

| Event                                                         | Request                                       |
| ------------------------------------------------------------- | --------------------------------------------- |
| Handed to the watcher, which confirms that it printed it      | `waiting`                                     |
| Handed over, no confirmation in 10 seconds, or the line broke | `waiting`, **unsure**; never handed out again |
| The watcher wasn't there when asked                           | `closed` (refused): nothing was sent          |
| Konfab stops meanwhile                                        | `waiting`, unsure, after the restart          |

Then as for Codex: 10 minutes, one use, closed by a cancel, pause, break, archive, removal, an ordinary join or any call by the agent. A late one gets "closed, end your turn". Cancel can't take back a wake-up that has been printed.

## What the card says

| Situation                             | Button                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Away, watcher called in the last 60 s | **Rejoin**                                                                                              |
| Waiting or working                    | Greyed out: "Available when the agent is away."                                                         |
| Away, no watcher                      | Greyed out: "Its watcher isn't running. Use the rejoin prompt."                                         |
| Joined before this existed            | Greyed out: "Not yet: restart the Konfab connector in Claude, then paste the rejoin prompt once."       |
| Asked, over 60 seconds                | "Not back yet. Look at its conversation in Claude: it may ask you something or have reached a limit. …" |

The texts name the app they are about. The room shows "… is back" after the first `wait_for_turn`, as for every agent.

## Approvals

The app may ask the lead to allow the command. Konfab changes no Claude setting. If the lead refuses, the agent reports it once, doesn't try another way, and stays with the manual prompts. Whether one approval lasts is to be tested.

## Off by default

`rejoin.claude_watcher: false`. Marked experimental. It is off until the lead turns it on, because it has the agent run a command.

## Tests before building (by hand, with the lead)

Each is recorded as passed, failed or not run. **If 1 or 2 fails, the rest isn't built** without a new decision.

| #   | Test                                                    | Why                                         |
| --- | ------------------------------------------------------- | ------------------------------------------- |
| 1   | Stop pressed while waiting, then the command ends       | the usual way to stop an agent              |
| 2   | A command ended by the lead's own act, after 60 minutes | the real use, not a timer                   |
| 3   | The app quit and opened again                           | expected to fail; then the card must say so |
| 4   | The conversation compacted, or its window closed        | long rooms                                  |
| 5   | Allowing the command                                    | whether the lead is asked every time        |
| 6   | A usage limit (only if one happens)                     | does the wake-up wait, fail or repeat?      |

## Automated tests

- Ticket: wrong, old, another app's, agent's or conversation's; only its hash is stored; it can't call anything else.
- Watcher against a stand-in server: silent while waiting; one line and an end for a request; server down, restarted, slow, endless, not Konfab; redirect; parent gone; two watchers.
- Delivery: each row above, with Konfab killed before and after each step; never handed out twice.
- The Codex tests for requests, races, secrets and wording, run for this path too.
- Nothing is offered while the setting is off, and the join answer is then byte for byte as now.

## Limits

- Claude may change how background commands work; then the button is greyed out and the prompts stay.
- A wake-up reads the whole conversation again, so it costs a turn of its size.
- A model that ignores "closed" and calls `join_room` joins as with a pasted prompt.

## Questions for the lead

1. Is it right to be **off** until you turn it on?
2. May the join prompt tell Claude to run this one command?
