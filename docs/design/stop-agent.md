# Stop button for one agent

**Status:** proposal for review. Nothing is built. The lead asked for it on 2026-11-24 and agreed that a running turn always finishes, and that it is for one agent at first (no "Stop all"). The name is decided: **Stop agent**, and **Stop after turn** while it works.

## Goal

The lead selects **Stop agent** on an agent's card. The agent is asked to leave the room's loop, so that it doesn't go on waiting; its conversation stays as it is, so **Rejoin** can bring it back. Nobody else is affected. It is the counterpart of **Rejoin**.

It isn't the app's own Stop button: Konfab can't interrupt work that an app is doing, and doesn't try to. No agent can use it.

## What the lead sees

| The agent is                                                           | On its card              | A click does                                                            |
| ---------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| Waiting for a turn, or has one queued                                  | **Stop agent**           | its session ends; its waiting call is answered with "stop"              |
| In a turn, or waiting for a permission in it                           | **Stop after turn**      | the turn finishes; then the same                                        |
| Working outside a turn (it reported work, and no waiting call is open) | **Stop after this work** | it is stopped at its next `wait_for_turn` (see the question at the end) |
| Away, not joined, its run window over, or on a break                   | Not shown                |                                                                         |

After the click:

| State                                                         | Text                                                                                                                    | Rejoin                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **asked** (a turn or work goes on)                            | Stopping after this turn (or work). **Keep in room**                                                                    | no                                                      |
| asked, and no call for longer than an agent should take       | Stop asked 18:40, but no call since 18:38. It may be working, hang, or have ended. Look in its app. **Keep in room**    | after the ordinary 90 seconds (or two missed check-ins) |
| **answered** (Konfab answered a call with "stop")             | Stop sent 18:40. Not confirmed.                                                                                         | 90 seconds after that answer, if it hasn't called since |
| **received** (its connector confirmed that it has the answer) | Stopped 18:40. Its app may take a moment to end its turn.                                                               | at once                                                 |
| ended while no call was open, and none has come since         | Stop not delivered yet. It is told at its next call. After 90 seconds also: It may have ended already. Look in its app. | after 90 seconds                                        |
| any of these, and it calls again later                        | Stopped 18:40, but it called again at 18:42. Its calls are refused. Look in its app.                                    | 90 seconds after that call                              |

**What each state proves.** _answered_: Konfab made the answer. _received_: the connector, a program on this computer, has it. Neither proves that the model read it, that the app's turn ended, or that allowance is no longer used; no text says so. A lost answer, a broken wait or a repeated call can't make _received_.

**Help text** of every form of the button: "Stops this agent in this room after its current turn; work already running in its app is not interrupted. This isn't the app's own Stop button." For one that waits, without "after its current turn".

No question is asked first: it can be undone (**Keep in room** or **Rejoin**). When the agent holds a lock, the button's help says that it is released when its session ends.

## How it works

`sessions` gets `stop_asked_at`, `stop_answered_at`, `stop_received_at` and `stop_called_at`.

1. **Click,** in one immediate transaction, for the agent's active session:
   - an active turn, or reported work (not stale) without an open waiting call: only `stop_asked_at` is set;
   - otherwise: the session ends with the reason `stopped`.
     Both are idempotent: a second click changes nothing.
2. **The end of the turn.** `post_message` and `pass_turn` end the session in **their own transaction** when the stop was asked and no other turn of that agent is active in the room (parallel answers finish as well). Their answer says: _The lead asked you to stop. End your reply now. Don't call wait_for_turn or another Konfab tool unless the user asks you to rejoin._ So no further call is needed.
3. **A waiting call,** held or new, of a session that is to stop and has no active turn ends that session and is answered at once with `closed`, the reason `stopped` and the same instruction. Agents already know `closed` as the end of the loop, so older connectors and prompts work.
4. `stop_answered_at` is set in the transaction that makes the first such answer. **`stop_received_at`** comes from the connector:
   - a waiting call: the `wait-finished` call that it already makes after it has an answer, for that very call number, and only if the stored outcome of that call was "stop";
   - post and pass: a new call `/agent/stop-received` with the session, which a connector makes after such an answer, once, and which changes nothing else. An older connector doesn't make it: then it stays _answered_.
5. **Any later call** of that session is refused with the same instruction, changes nothing and sets `stop_called_at`. It doesn't count as contact. Not counted as a call: `wait-finished`, `stop-received`, a repeated request with the same number (a lost answer), and the rest of the same held wait.
6. **Repeats after a lost answer:** the repeated post or pass finds its turn completed and is answered as before, with "stop" added from the session's state, not from the stored answer. So it is right whether the stop came before or after. A repeated wait is answered `closed` again.

During a turn, the answers of `report_status` and `wait_for_turn` say once that the lead asked for a stop after this turn. That is only a hint, so that an agent doesn't plan further work; nothing relies on it.

### Coming back

- A new state `stopped` is "away" for **Rejoin**, which is offered as in the table above: at once only when _received_.
- Codex: its turn ends by itself after "stop", so its queue takes the prompt; if the turn is still ending, it waits for that. Claude: its watcher stays; if the wake-up comes into the turn that is still ending, the agent sees the request there. Either way `rejoin_room` decides.
- The order is clear for a model: the request comes **after** the stop, by the lead's click, and is checked by Konfab. "Unless the user asks you to rejoin" names it. A stop by the app's own button is different, as today.
- **An ordinary join** works as ever. Konfab can't tell who wanted it: the lead who pasted a prompt, or an agent that joins by itself against its instruction. So it never says that the lead did. While _asked_, the join replaces the session and with it the stop: the card says for 10 minutes, and the activity always, **"It joined again at 18:41. Your Stop no longer applies."** with **Stop** beside it. After it was stopped: "codex is back" in the room, and in the activity "joined after a stop". It is in the room's line too, so that it isn't missed.
- **Run window:** see below.

### The run window

- When a session ends by a stop, in the same transaction, what is left of its window is stored as it is for a break (`room_members.saved_run_ms`). A pause counts as it does today: frozen time isn't lost.
- The next join takes what is stored and clears it, as after a break. So stop and rejoin, however often, only ever continue one window, and a restart of Konfab in between changes nothing.
- **While _asked_ the window runs on.** If it ends first, the session ends as "run window ended", nothing is stored, and the next join gets a fresh one, as today.
- **A break** while _asked_ stores the rest at the break, as today; the session then ends as "break", and what is stored isn't written again. A stop after a break isn't offered. A break after a stop doesn't touch an ended session, so what the stop stored stays.
- **An agent that never receives the stop** (no call was open, or the answer was lost): its session has ended and the rest is stored all the same. What its app uses meanwhile isn't counted, because Konfab can't see it.
- A stop that was undone stores nothing.

### The queue

All of this is in the transactions that exist; only conditions are added. A session with `stop_asked_at` **gets no further turn** and **doesn't hold the queue**.

| Situation                                        | What happens                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| It has a queued turn                             | the row stays as it is (its number, reason, notices). New messages join it, as today: one queued turn per agent                                                                      |
| Others behind it                                 | `activateNext` passes over a queued turn whose agent has no live session; "asked" counts as that. Their order among themselves stays                                                 |
| It comes back, or is kept                        | its row has its old number, so it is next when the running turn ends. Nothing that others have started is taken back                                                                 |
| Parallel answers                                 | each has its own row. Running ones finish; the session ends with the last. Queued ones stay queued for it. The limit of parallel turns counts running ones only, so it blocks nobody |
| A format's step is its                           | the step's row stays queued, and **the format waits**, also when others are queued outside the format, as today. Skip is the lead's                                                  |
| A format reaches its step while _asked_          | the row is made and waits                                                                                                                                                            |
| Its turn times out while _asked_                 | queued again exactly as today, once. The session stays _asked_; it isn't ended, so a long command keeps its locks                                                                    |
| A join while its turn runs                       | queued again as today, and the new session gets it                                                                                                                                   |
| `next: self`, a hand-off or a mention to it      | queued as always                                                                                                                                                                     |
| `hand_off`, automatic continuation, the watchdog | treat it as an agent that needs a rejoin                                                                                                                                             |

Stop and **Keep in room** are immediate transactions on the same database as `activateNext`, `activateParallel`, `finishTurn` and `abandonAndRequeue`: whichever comes first decides, and each looks at `stop_asked_at` and the turns inside its own transaction.

## Work that belongs to a stopped agent

Nothing is given to somebody else by itself, and nothing is dropped.

| Work                                          | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The lead's messages and mentions              | queued, as for an agent that is away. The note under the box: "Codex is stopped, so your mention is waiting." with **Rejoin** when it can be used, and the prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A hand-off from another agent (`next: agent`) | stays queued. The room's next step says "Waiting for codex (stopped)". The lead can rejoin it, or write to somebody else, which replaces a waiting hand-off as today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hand_off` to it                              | refused as today, with "stopped by the lead"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Its own `next: self`                          | stays queued                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Turns queued for others behind its own        | go on: a stopped agent doesn't hold the queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A step of a review or debate                  | the format waits and says so, with **Rejoin** and the **Skip** that is there today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| An automatic continuation for it              | waits as "needs a rejoin", as today for an agent that is away                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Advisory locks                                | kept while _asked_, also if nothing is heard from it, until their own lease ends. Released when the session ends: at the end of its turn, at its next wait, or at the click if it was waiting. An agent that holds a lock and works on without a reported status is the one case where a lock is released under running work; as today at a break, locks are advisory                                                                                                                                                                                                                                                                                                                                      |
| A permission it asked for                     | the request stays in the list, and the lead can answer it. Waiting for it **in a turn**: that turn can finish, and gets the answer. Waiting **outside a turn**: counts as work, so the stop comes at its next `wait_for_turn`, and it gets the answer. Once its session has ended, `request_permission` and its wait are **refused**, as for any ended session today. After a rejoin the new session can ask for the same request by its number, because that depends on the agent and the room. But the agent must still know the number, and nothing tells it again: **so a permission answered after a stop may go unused**, and a request may have to be made again. The card says so when one is open |
| Phone notices                                 | none because of a stop by the lead; a waiting permission is still told                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Races

Everything takes the same write lock, so one comes first.

| First                               | Then                                                                  | Outcome                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Stop                                | its call that would start a turn                                      | no turn: told to stop; the turn stays queued                                                               |
| its call that starts a turn         | Stop                                                                  | the turn runs; Stopping                                                                                    |
| Stop during a turn                  | post or pass                                                          | the post is kept, the turn is done, the session ends; its answer says stop                                 |
| post or pass                        | Stop                                                                  | the session ends at once; the next call is told                                                            |
| the same post again (a lost answer) |                                                                       | the first answer again, with stop in it; nothing twice (receipts as today)                                 |
| Keep in room                        | post or pass                                                          | it stays                                                                                                   |
| post or pass                        | Keep in room                                                          | too late (409): "It has stopped; use Rejoin"                                                               |
| Stop during reported work           | its next `wait_for_turn`                                              | no turn: told to stop                                                                                      |
| Stop during reported work           | the report goes stale, or contact is lost                             | still _asked_, locks kept; the card says that nothing is heard, and Rejoin is offered after the usual time |
| Stop during a turn                  | the turn times out                                                    | queued again, still _asked_; told at its next call                                                         |
| Stop during a turn                  | pause or resume                                                       | no effect on each other; a paused room can be left                                                         |
| Stop during a turn                  | break                                                                 | the session ends once, with the break's reason; the room is on a break. Rejoin is as in a break            |
| break                               | Stop                                                                  | not offered (the agent is leaving already); the call is 409                                                |
| Stop                                | archive, removal from the room                                        | as today; nothing of the stop is left                                                                      |
| Stop asked                          | an ordinary join                                                      | the stop no longer applies, and the card and the activity say so                                           |
| Stop (ended)                        | an ordinary join                                                      | it is back; "joined after a stop"                                                                          |
| Stop                                | its session's `activateNext` or `activateParallel` in the same moment | one of the first two rows; never a turn for an ended session, never two                                    |
| Keep in room                        | `activateNext`                                                        | it may get its queued turn                                                                                 |
| `activateNext` for another agent    | Keep in room                                                          | the other's turn goes on; its own is next                                                                  |
| Rejoin asked (agent away)           | Stop                                                                  | not offered: it isn't there. Cancel is the way                                                             |
| `rejoin_room`                       | Stop before its first wait                                            | the new session ends; the request stays `joined`, and can be asked again                                   |
| Stopped                             | Rejoin, then a late call of the old session                           | refused; it doesn't close the request, because an ended session can't be in contact                        |
| Konfab stops after the click        |                                                                       | what was stored counts: an ended session is ended; Stopping goes on; nothing is told that wasn't           |

## The page and the API

- `POST` and `DELETE /api/rooms/:id/agents/:agent/stop`, for the signed-in lead on this page only. Agents have no route. No body.
- Card: the texts above, as a status that is read out; keyboard, both themes, 375 px. While it works, **Stop after turn** is a plain button, not a red one.
- Room header and participants: "Codex: Stopped". The count of working agents leaves it out.
- The room shows "Codex was stopped" and, as today, "Codex is back".
- Activity: "stop asked", "stop undone", "stopped", "called after stop", "joined after a stop".
- Export and agents' messages: nothing. Other agents see it only where they already see who can be handed work.

## Not included

Stop all; stopping at a time or after an idle time; interrupting a running turn; stopping by an agent; moving queued work to somebody else with a button; rejoining by itself.

## Tests

- Every row of "What the lead sees", "Work that belongs to a stopped agent" and "Races", both orders for each race, with two processes on one database file where both sides write.
- Each statement of the transactions made to fail: nothing of it is left.
- The held wait is answered within a second; also with an older connector and through the real connector; a lost answer of post, pass and wait, repeated.
- Konfab killed before and after each state; the agent's process killed while Stopping; a turn that times out.
- Parallel answers: stopped only after the last.
- Both Rejoin routes after a stop, with stand-ins: at once when received, after 90 seconds otherwise, refused while asked; one session.
- Run window: saved once, not refreshed by stop and rejoin, also after several.
- **Lost answers:** the answer of post, pass and a held wait lost at each point (before the server's write, on the way, before the connector's confirmation, the confirmation itself), with and without a repeat, and with an older connector: never "Stopped" without the confirmation, and Rejoin at the stated time.
- **The queue:** every row of its table, with more agents behind, formats and parallel answers; stop, undo and activation in both orders from two processes; afterwards each piece of work is there exactly once and belongs to whom it did.
- **The run window:** every point of its list, also with a pause, a restart and five stops and rejoins in a row; never more time than one window.
- **Joins while asked**, by a pasted prompt and by the agent itself: same texts, and no text says who wanted it.
- **Permissions and locks** outside a turn: answered before and after the session ends, refused, connection lost, the app gone; a lease that ends while asked.
- The page: texts, undo, focus after the button changes, themes, narrow width.

By hand, with the lead, in both apps: stop while waiting; stop during a turn; Keep in room; Rejoin afterwards; whether the app's turn really ends.

## Limits

- It relies on the model ending its reply when it is told. If it doesn't, its calls are refused, but the app's turn may go on and use allowance. The card says when it calls again.
- Work that the app does outside a Konfab turn is only known from what the agent reported. One that works without reporting it looks as if it were waiting, and is stopped at its next call; what it does in its app isn't touched.
- An agent that isn't calling (hung, or waiting for a question in its app) can't be told.

## Question for the lead

When an agent **works outside a turn** (it reported "working", as while building or testing), should **Stop** end its session **at once**, or **at its next `wait_for_turn`**? Proposed, and written above: at its next wait, shown as **Stop after this work**. It keeps its locks and a permission it waits for, and can be undone meanwhile; but it can take long.
