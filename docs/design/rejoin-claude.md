# Rejoin for Claude agents: a background watcher

**Status:** for review before building; nothing is built. The lead decided on 2026-11-24, after the tests by hand, that it is built, and that the join prompt may ask for the one command. It extends the [Rejoin agents button](rejoin-agents.md), whose requests, checks and wording stay as they are. Evidence: [automatic rejoin](automatic-rejoin.md).

## Goal

The lead selects **Rejoin** on a Claude agent's card, and the agent comes back in its own conversation. The manual prompts always stay. Konfab never does it by itself.

## What is known

| Fact                                                                                                                                                    | How                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| The Claude app starts a conversation again when a background command it started ends, 4 to 6 seconds later                                              | Seen twice in its own window, turn ended by the agent: a 2-minute timer, and 32 minutes ended by the lead's own act |
| Waiting that way uses no turn                                                                                                                           | Seen in both                                                                                                        |
| The connector's environment has the conversation's id (`CLAUDE_CODE_SESSION_ID`), and it is the same after the conversation was compacted several times | Seen in the running connector, and equal to the conversation's own record                                           |
| The app marks the wake-up as an automatic event, not as the lead's words                                                                                | Seen in all three                                                                                                   |
| After **Stop** the app starts the conversation all the same; the agent then stayed out, because it had been stopped                                     | Seen once, own window                                                                                               |
| After a usage limit, hours, sleep, compaction, or with the app closed                                                                                   | **Not known**                                                                                                       |
| A documented way to send a prompt into an open conversation from outside                                                                                | None found                                                                                                          |

Not used: the app's private message socket (undocumented), `claude --resume` (outside the window the lead sees), Channels (need a start option; the desktop app isn't mentioned), timed wake-ups (each one uses allowance).

## How it works

1. The lead's join or rejoin prompt says, once and in advance: _start the watcher that `join_room` gives you, in the background; when it ends, call `rejoin_room` with what it printed and follow the answer._
2. `join_room` answers with one fixed command: `node <Konfab>/dist/cli/watch.js <watch number>`. The number is a small integer and no secret. Nothing anyone wrote is in the command.
3. The watcher asks Konfab on this computer, over and over, whether it is wanted. It prints nothing and uses no allowance.
4. The lead selects **Rejoin**. The watcher prints the one-time request number, tells Konfab that it did, and ends.
5. The app starts the conversation. The agent calls `rejoin_room`; every check of the Codex design applies. The answer gives a new watcher.

### What is enforced, and what isn't

The sentence in step 1 is **an instruction to a model, not an authorization boundary.** The wake-up is data that a process printed. A model may ignore both, start no watcher or several, run something else, or call `join_room` by itself; the app's own approvals decide what it can run. Konfab enforces only its own side: who is told a request number, and the checks of `rejoin_room`. Nothing else in this design relies on the model doing as it is told: if it doesn't, the worst outcomes are no rejoin, an extra turn, or an ordinary join as with a pasted prompt.

## After Stop

Stop is the lead's word, and the app tells the agent to wait for the lead. The wake-up and what the watcher prints are not the lead's word. So in the test the agent was woken and rightly stayed out; it can't tell a Stop for a moment from one that is meant. Konfab can't see Stop either.

Konfab doesn't try to overrule it.

- The join prompt says that after a Stop the agent doesn't use a request; it ends its turn and says that it was stopped.
- The card says after 60 seconds: "Not back yet. If you pressed Stop, paste the rejoin prompt."
- The button is so for an agent that ended its own turn, or whose turn ended in an error; a stopped one needs the prompt.

The other way, a sentence in the join prompt that a click on **Rejoin** also counts after Stop, would be the lead's own advance word. But a model may still hold to the later Stop, and a late or false request would then undo a Stop. It isn't done.

## The endpoint

`POST /agent/watch` and `POST /agent/watch/printed`, on the same server: 127.0.0.1 only, with the Host and Origin checks of the other agent routes, JSON of at most 1 KB, and no cookies.

- **Authentication:** `Authorization: Bearer <ticket>`. A ticket (130 random bits, its own prefix) is accepted on these two routes and nowhere else; the connector's token isn't accepted here, and the ticket can't join, read or post.
- **Where the ticket is:** the server writes it to `~/.konfab/watch/<watch number>`, mode 0600 in a 0700 folder, made exclusively and never through a link. The watcher reads it from there and refuses a file of another owner or mode. So it is in no conversation, process list, log, page or backup; the database has its hash. It is deleted when the ticket ends.
- **Calls:** `watch` is held for at most 25 seconds and answers `{"status":"wait"}`, `{"status":"print","request":…,"handover":…}`, `{"status":"rest"}` or `{"status":"leave"}`. A ticket that has ended is still good for `rest` and `leave`, and for nothing else. `printed` takes the handover number, once. Anything else is refused without saying why; 20 wrong tickets in a minute stop the route for a minute.
- The requests are in no log, as for the other waiting calls.

## The life of a ticket

| State    | From                                                                                                                                            | To                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `issued` | a join or rejoin by the Claude connector, with a conversation, the setting on, and no `issued` or `live` ticket for that agent and conversation | `live` at the first call; `ended` after 2 minutes without one |
| `live`   | its watcher has called                                                                                                                          | `used`, `ended`                                               |
| `used`   | a request was handed to it (stored **before** the answer is sent)                                                                               | stays; its file is deleted                                    |
| `ended`  | the agent was archived, its app's token changed, the setting was turned off, 7 days, or no call for 24 hours while Konfab was running           | stays; its file is deleted                                    |

- `gone` follows `used` or `ended` when its watcher has said goodbye, or hasn't called for 24 hours while Konfab was running.
- A ticket belongs to one app, agent and conversation, not to a room or a session: a rejoin keeps it, and it is told of a request for any room that agent joined from that conversation. A room it may not join is stopped by the checks of the request, as always. The conversation's id comes from the connector's own environment; missing or not a lower-case UUID means no watcher. As for Codex it is a routing signal, not proof.
- At most one `issued` or `live` ticket per agent and conversation (unique in the database), and 20 new ones a day for each agent. Past that: manual prompts.

## Old and duplicate watchers

**Every end of a watcher wakes the agent and costs a turn.** Only one that ends while the agent's turn is running is taken into that turn (seen once, in the Stop test that wasn't stopped). So it ends only (a) after printing a request, (b) at once at its start, saying why, if it can't work at all (no file, wrong owner, no server in 10 seconds, network blocked), (c) when it is cleaned up, or (d) with the app.

| Case                                            | What happens                                                                                                                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ticket ended                                | `rest`: the watcher does nothing but call once a minute, so that it can be counted and cleaned up; it wakes nobody                                                                                                    |
| Started a second time with the same number      | each watcher sends a random number of its own; the first keeps the place while its last call is under 2 minutes old, and the second is told so, prints one line and ends at once, in the turn in which it was started |
| The agent joins again while its watcher is live | the answer says that one is running and gives no command                                                                                                                                                              |
| Konfab is stopped                               | it tries again after 1, 2, 4 … 30 seconds, silently, for as long as the app runs                                                                                                                                      |
| The app is gone                                 | at its start it notes the processes above it, up to the app, and every 30 seconds it looks whether they are still there (macOS `ps`, its full path); if one is gone it ends; nobody is there to wake                  |

### A fixed limit, and cleaning up

A resting watcher keeps about 40 MB (to be measured, test 7). The app may stay open for weeks, so a daily limit isn't enough:

- **Limit:** at most 3 watchers per conversation, 6 per app, whatever their state. A watcher counts from its ticket until Konfab knows that it is gone: it said goodbye, or hasn't called for 24 hours while Konfab was running. At the limit `join_room` gives no command and the manual prompts stay; the button says "Its watcher isn't running. Use the rejoin prompt." So at most about 240 MB per app, however long it runs.
- **Cleaning up:** a resting watcher is told `leave` only while its own agent has a `wait_for_turn` call open in that conversation. It then says goodbye, prints one fixed line ("Konfab watcher ended; nothing to do.") and ends. One at a time.
- **If it wakes the conversation all the same** (the turn ended in that moment, or the app behaves differently): the line carries no request, and the join prompt says that such a line means _end your turn, start nothing_. That is one short turn. It can't repeat, because that watcher is gone. Konfab can't see a wake-up in which the agent calls nothing, so the cost is bounded instead: **at most 2 clean-ups per conversation a day**, whatever happens. A call from that conversation within 60 seconds of a `leave`, without an open wait, switches cleaning up off for it; the limit still holds.
- **If cleaning up isn't possible** (the agent never comes back): they rest, within the limit, until the app closes. Nothing else ends them, and Konfab never kills a process: it doesn't know the numbers, and it wouldn't be sure whose they are.
- **By hand:** stopping the background commands in the app, or closing it. The page shows the count on the card when it is more than one: "2 old watchers are resting; they end when Claude is closed."

## Delivery: at most once

A request is handed over only on a `watch` call that is **open at that moment**. If none is open within 5 seconds of the lead's click, the request is closed as refused: nothing was sent.

**Printed** means: the watcher wrote the whole line to its output in one call, the operating system took all of it, and Konfab then received `printed`. It doesn't mean that the app read it or that the model saw it; only `back` is success. If the write fails, is short, or the pipe is closed, the watcher doesn't write again and doesn't confirm.

| Event                                                                               | Request                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| No open call                                                                        | `closed` (refused): nothing was sent                                     |
| Handed over and `printed` received                                                  | `waiting`                                                                |
| Handed over, and no `printed` in 10 seconds: short write, closed pipe, killed, lost | `waiting`, **unsure**; `printed` may still make it sure while it is open |
| The `printed` call is lost                                                          | the watcher repeats it for 10 seconds, then ends; `waiting`, unsure      |

Never handed out twice, to this or another watcher: the ticket is `used` in the same transaction that makes the request `sending`.

| Stopped                              | Before the handover                                                                  | Between handover and print                                            | After the print                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Watcher** killed                   | its call closes: greyed out. The app may wake the agent, which is told nothing to do | unsure; the app may wake the agent without a number: it ends its turn | as printed                                                              |
| **App** quit or crashed              | no watcher; greyed out                                                               | unsure, expires                                                       | `waiting`, expires; if the app delivers it later, `rejoin_room` decides |
| **Konfab** stopped, crashed, updated | nothing pending; the watcher calls again                                             | unsure after the start; not handed out again                          | `waiting` or unsure; the number works until it expires                  |
| **Computer** asleep                  | the call breaks and is made again                                                    | unsure                                                                | expiry runs on by the clock                                             |

Then as for Codex: 10 minutes, one use, closed by a cancel, pause, break, archive, removal, an ordinary join or any call by the agent. A late one gets "closed, end your turn". Cancel can't take back what was printed.

## What the card says

| Situation                      | Button                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Away, and a watch call is open | **Rejoin**                                                                                              |
| Waiting or working             | Greyed out: "Available when the agent is away."                                                         |
| Away, no watcher               | Greyed out: "Its watcher isn't running. Use the rejoin prompt."                                         |
| Joined before this existed     | Greyed out: "Not yet: restart the Konfab connector in Claude, then paste the rejoin prompt once."       |
| Asked, over 60 seconds         | "Not back yet. Look at its conversation in Claude: it may ask you something or have reached a limit. …" |

The texts name the app they are about. The room shows "… is back" after the first `wait_for_turn`, as for every agent.

## Approvals

The app may ask the lead to allow the command. Konfab changes no Claude setting. If the lead refuses, the agent reports it once, doesn't try another way, and stays with the manual prompts. Whether one approval lasts is to be tested.

## Off by default

`rejoin.claude_watcher: false`, and macOS only. Marked experimental. It is off until the lead turns it on, because it has the agent run a command. While it is off, `join_room` answers and the prompts are as now.

## Tests by hand, with the lead

Each is recorded as passed, failed or not run.

| #   | Test                                                                                                                                                               | Why                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 1   | Stop pressed while waiting, then the command ends. **Run once (2026-11-23): the app woke it; the agent didn't come back** (see After Stop)                         | the usual way to stop an agent                   |
| 2   | A command ended by the lead's own act, after 60 minutes. **Run once (2026-11-23) with 32 minutes, as the lead chose a shorter one: passed**, back without a prompt | the real use, not a timer                        |
| 3   | The app quit and opened again                                                                                                                                      | expected to fail; then the card must say so      |
| 4   | The conversation compacted, or its window closed                                                                                                                   | long rooms                                       |
| 5   | Allowing the command                                                                                                                                               | whether the lead is asked every time             |
| 6   | A usage limit (only if one happens)                                                                                                                                | does the wake-up wait, fail or repeat?           |
| 7   | A command stopped by the agent; one that ends during its turn; one left resting                                                                                    | does either wake it; the memory of a resting one |

Tests 1 and 2 were the condition for building. After test 1 the lead took the new decision to build it, with the manual prompt after Stop. Tests 3 to 7 are for the built feature; the experimental mark stays until they are done. They need the lead.

## Automated tests

- Ticket: wrong, ended, used, another app's, agent's, room's or conversation's; every state change in its table; only its hash is stored; it is refused on every other route, and the connector's token on these; its file's owner, mode, link and deletion.
- Watcher against a stand-in server: silent while waiting and resting; one line and an end for a request; server down, restarted, slow, endless, not Konfab; redirect; parent gone; started twice.
- Limits and cleaning up: 3 per conversation and 6 per app over simulated weeks, with restarts; `leave` only with an open wait and one at a time; at most 2 a day; a call without an open wait soon after one switches it off; never a process killed.
- Output: full, short and failed writes, a closed pipe, a full pipe, and a kill before and after the write and the confirmation.
- Delivery: each row and field of both tables, with each side killed before and after each step; a handover racing with a second click, a cancel, an expiry and a new ticket; never handed out twice.
- The Codex tests for requests, races, secrets and wording, run for this path too.
- Nothing is offered while the setting is off, and the join answer is then byte for byte as now.

## Limits

- Claude may change how background commands work; then the button is greyed out and the prompts stay.
- A wake-up reads the whole conversation again, so it costs a turn of its size.
- After Stop the manual prompt is needed.
- A model that ignores "closed" and calls `join_room` joins as with a pasted prompt.
