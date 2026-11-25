# Stop button for one agent

**Status:** proposal for review. Nothing is built. The lead asked for it on 2026-11-24 and agreed that a running turn always finishes, and that it is for one agent at first (no "Stop all").

## Goal

The lead selects **Stop** on an agent's card. The agent leaves the room's loop, costs no allowance, and its conversation stays as it is, so **Rejoin** can bring it back. Nobody else is affected. It is the counterpart of **Rejoin**.

It isn't the app's own Stop button: Konfab can't interrupt work that an app is doing, and doesn't try to. No agent can use it.

## What the lead sees

| The agent is                                                           | On its card                                                                                        | A click does                                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Waiting for a turn, or has one queued                                  | **Stop**                                                                                           | its waiting call is answered with "stop" at once                        |
| In a turn, or waiting for a permission in it                           | **Stop after turn**                                                                                | the turn finishes; then it is stopped                                   |
| Working outside a turn (it reported work, and no waiting call is open) | **Stop after this work**                                                                           | it is stopped at its next `wait_for_turn` (see the question at the end) |
| Stopping                                                               | **Stopping after this turn** (or **work**) · **Keep in room**                                      | Keep in room undoes it, until it has stopped                            |
| Told to stop, and quiet since                                          | **Stopped · 18:40** · **Rejoin** (or the rejoin prompt)                                            |                                                                         |
| Stopped by Konfab, but no call of it was answered                      | **Stopping · not answered yet**; after 90 seconds: "It may have stopped already. Look in its app." |                                                                         |
| Told to stop, and it called again                                      | "Stopped · 18:40, but it called again at 18:42. Its calls are refused. Look in its app."           |                                                                         |
| Away, not joined, its run window over, or on a break                   | Not shown                                                                                          |                                                                         |

No question is asked first: it can be undone (**Keep in room** or **Rejoin**) and loses nothing. When the agent holds a lock, the button's help says that it is released.

**What Konfab can't know:** whether the app's turn has really ended. "Stopped" means _told, and no call since_. It is never shown only because of the click.

## How it works

`sessions` gets `stop_asked_at`, `stop_told_at` and `stop_called_at`.

1. **Click,** in one immediate transaction, for the agent's active session:
   - an active turn, or reported work (not stale) without an open waiting call: only `stop_asked_at` is set;
   - otherwise: the session ends with the reason `stopped`.
     Both are idempotent: a second click changes nothing.
2. **The end of the turn.** `post_message` and `pass_turn` end the session in **their own transaction** when the stop was asked and no other turn of that agent is active in the room (parallel answers finish as well). Their answer says: _The lead asked you to stop. End your reply now. Don't call wait_for_turn or another Konfab tool unless the user asks you to rejoin._ So no further call is needed.
3. **A waiting call,** held or new, of a session that is to stop and has no active turn ends that session and is answered at once with `closed`, the reason `stopped` and the same instruction. Agents already know `closed` as the end of the loop, so older connectors and prompts work.
4. `stop_told_at` is set in the transaction that makes such an answer. It is the proof that Konfab answered, not that the model read it.
5. **Any later call** of that session is refused with the same instruction, changes nothing and sets `stop_called_at`. It doesn't count as contact.

During a turn, the answers of `report_status` and `wait_for_turn` say once that the lead asked for a stop after this turn. That is only a hint, so that an agent doesn't plan further work; nothing relies on it.

### Coming back

- A new state `stopped` is "away" for **Rejoin**. It is offered **as soon as the agent has been told**; there is no wait for **No contact**. For one that wasn't told, the ordinary 90 seconds apply.
- Codex: its turn ends by itself after "stop", so its queue takes the prompt; if the turn is still ending, it waits for that. Claude: its watcher stays; if the wake-up comes into the turn that is still ending, the agent sees the request there. Either way `rejoin_room` decides.
- The order is clear for a model: the request comes **after** the stop, by the lead's click, and is checked by Konfab. "Unless the user asks you to rejoin" names it. A stop by the app's own button is different, as today.
- An ordinary join (a pasted prompt) works as ever and ends the stop. Konfab can't tell a pasted prompt from an agent that joins by itself against its instruction. So the room shows "… is back" and the activity shows "joined after a stop", for the lead to notice.
- **Run window:** what is left is saved and given back at the next join, as after a break. A stop doesn't give a fresh window.

## Work that belongs to a stopped agent

Nothing is given to somebody else by itself, and nothing is dropped.

| Work                                          | What happens                                                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The lead's messages and mentions              | queued, as for an agent that is away. The note under the box: "Codex is stopped, so your mention is waiting." with **Rejoin** when it can be used, and the prompt          |
| A hand-off from another agent (`next: agent`) | stays queued. The room's next step says "Waiting for codex (stopped)". The lead can rejoin it, or write to somebody else, which replaces a waiting hand-off as today       |
| `hand_off` to it                              | refused as today, with "stopped by the lead"                                                                                                                               |
| Its own `next: self`                          | stays queued                                                                                                                                                               |
| Turns queued for others behind its own        | go on: a stopped agent doesn't hold the queue                                                                                                                              |
| A step of a review or debate                  | the format waits and says so, with **Rejoin** and the **Skip** that is there today                                                                                         |
| An automatic continuation for it              | waits as "needs a rejoin", as today for an agent that is away                                                                                                              |
| Locks                                         | kept while its turn runs, released when its session ends                                                                                                                   |
| A permission it asked for                     | stays, and can be answered. Asked in a turn, it belongs to the turn, which can still finish. Asked outside one, the agent gets the answer by asking again after it rejoins |
| Phone notices                                 | none because of a stop by the lead; a waiting permission is still told                                                                                                     |

## Races

Everything takes the same write lock, so one comes first.

| First                               | Then                                        | Outcome                                                                                          |
| ----------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Stop                                | its call that would start a turn            | no turn: told to stop; the turn stays queued                                                     |
| its call that starts a turn         | Stop                                        | the turn runs; Stopping                                                                          |
| Stop during a turn                  | post or pass                                | the post is kept, the turn is done, the session ends; its answer says stop                       |
| post or pass                        | Stop                                        | the session ends at once; the next call is told                                                  |
| the same post again (a lost answer) |                                             | the first answer again, with stop in it; nothing twice (receipts as today)                       |
| Keep in room                        | post or pass                                | it stays                                                                                         |
| post or pass                        | Keep in room                                | too late (409): "It has stopped; use Rejoin"                                                     |
| Stop during reported work           | its next `wait_for_turn`                    | no turn: told to stop                                                                            |
| Stop during reported work           | the report goes stale, or contact is lost   | the session ends, not told: "not answered yet"                                                   |
| Stop during a turn                  | the turn times out                          | the turn is queued again, the session ends, not told: "not answered yet"                         |
| Stop during a turn                  | pause or resume                             | no effect on each other; a paused room can be left                                               |
| Stop during a turn                  | break                                       | the session ends once, with the break's reason; the room is on a break. Rejoin is as in a break  |
| break                               | Stop                                        | not offered (the agent is leaving already); the call is 409                                      |
| Stop                                | archive, removal from the room              | as today; nothing of the stop is left                                                            |
| Stop                                | an ordinary join                            | the new session has no stop                                                                      |
| Rejoin asked (agent away)           | Stop                                        | not offered: it isn't there. Cancel is the way                                                   |
| `rejoin_room`                       | Stop before its first wait                  | the new session ends; the request stays `joined`, and can be asked again                         |
| Stop, told                          | Rejoin, then a late call of the old session | refused; it doesn't close the request, because an ended session can't be in contact              |
| Konfab stops after the click        |                                             | what was stored counts: an ended session is ended; Stopping goes on; nothing is told that wasn't |

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
- Both Rejoin routes after a stop, with stand-ins: at once when told, refused work while away, one session.
- Run window: saved once, not refreshed by stop and rejoin, also after several.
- Never "Stopped" without an answer; never a turn for a stopped session; others go on; nothing dropped or given away.
- The page: texts, undo, focus after the button changes, themes, narrow width.

By hand, with the lead, in both apps: stop while waiting; stop during a turn; Keep in room; Rejoin afterwards; whether the app's turn really ends.

## Limits

- It relies on the model ending its reply when it is told. If it doesn't, its calls are refused, but the app's turn may go on and use allowance. The card says when it calls again.
- Work that the app does outside a Konfab turn is only known from what the agent reported. One that works without reporting it looks as if it were waiting, and is stopped at its next call; what it does in its app isn't touched.
- An agent that isn't calling (hung, or waiting for a question in its app) can't be told.

## Question for the lead

When an agent **works outside a turn** (it reported "working", as while building or testing), should **Stop** end its session **at once**, or **at its next `wait_for_turn`**? Proposed, and written above: at its next wait, shown as **Stop after this work**. It loses nothing, keeps its locks, and can be undone meanwhile; but it can take long.
