# Stop and Rejoin in every situation

**Status:** proposal for discussion. Nothing is built. The lead asked for it on 2026-11-25: Stop and Rejoin should work in many situations, and be easy to use. It builds on [Rejoin agents](rejoin-agents.md), [Rejoin for Claude](rejoin-claude.md) and [Stop agent](stop-agent.md), whose checks stay: one-time requests, one transaction, no false "back".

## What went wrong for the user

In the evening the lead interrupted both agents in their apps and paused the room. In the morning: **Resume**, **Rejoin** for both, and nothing for two minutes. Both requests had arrived; Codex held its one, and Claude didn't use its one, both because of the interruption. The lead had to find out in each app what to do: **Steer** in one, a pasted prompt in the other.

Each part did what it was built for. Together it was a dead end: a button that looked as if it had worked, no next step on the page, and a different cure in each app.

## Principles

1. **Rejoin always leads on.** It is never a dead end and, for an agent that is away, never grey. If the silent way can't work, the same click does the next best thing.
2. **The page says what to do next, at once,** in one line, with one button. It doesn't wait for a minute to say it.
3. **One click per wish.** "Bring them back" in the morning is one click, also in a paused room. "Let them stop" in the evening is one click.
4. **Konfab says only what it knows.** What it can't see (an interruption in Codex, a usage limit) is offered as "if", with the cure.
5. **Nothing is done behind the lead's back:** no window opened, no message sent, without the click that asks for it.

## Rejoin as a ladder

One click goes as far as it can. The card shows the step it has reached.

| Step | What happens                                                                                                                         | The lead does                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| 1    | **Silent:** the queue (Codex) or the watcher (Claude), as today                                                                      | nothing                           |
| 2    | **Open:** Konfab opens the agent's own conversation in its app. The rejoin prompt is in the clipboard                                | selects **Open its conversation** |
| 3    | **Paste:** ⌘V and Enter in that conversation. For Codex, if it shows "Queue paused because you interrupted", **Resume** does as well | one or two keys                   |

- If step 1 is known to be impossible, the first click does step 2 at once, and the button says so before: **Open and rejoin**. (Claude without a watcher, Claude or Codex not running, no command, an old connector.)
- After step 1, the card shows **Open its conversation** right away beside "waiting", without pushing it. After 20 seconds without success it is the main button, with the reasons that fit.
- The manual prompts stay as they are.

### Opening one conversation

| App    | Way                                                                                                     | Known from                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Codex  | `codex://threads/<id>`                                                                                  | opened it, and delivered a waiting message (by the lead, 2026-11-23)                                                                    |
| Claude | `claude --desktop --resume <id>`                                                                        | documented: opens that conversation in the app. **Not tried**; whether it stays the same one when the app already has it must be tested |
| both   | `open -a` the app, if the conversation can't be opened; then the card says which conversation to choose | ordinary macOS                                                                                                                          |

The server does it, on the lead's click only, with a fixed command, a checked path and the stored id, which the page never sees. The id is checked as a UUID. Nothing else is in the command; the prompt goes to the clipboard by the page itself, so that the lead sees what is pasted.

## Situations

How sure: **P** proven with the real app; **D** documented by the app, not tried; **E** expected, or only with stand-ins; **?** not known; **X** not possible with what was found (see the next section).

| Situation                                       | The lead clicks                                | Konfab can observe                                     | Expected                                                                         | Shortest recovery if not                  | How sure                                 |
| ----------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| Agent ended its own turn                        | **Rejoin**                                     | no contact; sent; joined; waits                        | back                                                                             | Open its conversation, paste              | P (both)                                 |
| **Stop agent**                                  | **Rejoin**                                     | stopped, its connector has it; sent; joined; waits     | back                                                                             | the same                                  | P (both, waiting); E (after a turn)      |
| Codex interrupted in its app                    | **Rejoin**                                     | no contact; taken into the queue. Not the interruption | held by Codex; the card says at once "If it shows 'Queue paused', select Resume" | **Open its conversation**, Resume         | P (held); X (releasing it from outside)  |
| Claude interrupted in its app, decision 1 A     | **Rejoin**                                     | printed; then the agent's own answer "stopped here"    | not back; the card says so in seconds                                            | **Open its conversation**, paste          | P (woken, not used); E (the answer)      |
| the same, decision 1 B                          | **Rejoin**                                     | printed; joined; waits; or the agent's answer          | back, unless the model holds back                                                | as A                                      | ?                                        |
| Codex app closed                                | **Open and rejoin**                            | its app isn't running; sent                            | opens the conversation; the prompt starts                                        | paste                                     | P (opening; delivery), E (as one)        |
| Codex open, this conversation not loaded        | **Rejoin**                                     | taken into the queue                                   | starts when it is loaded                                                         | **Open its conversation**                 | P                                        |
| Claude app closed                               | **Open and rejoin**                            | its app isn't running; no watcher                      | the conversation opens; paste                                                    | `open -a`, choose it, paste               | D                                        |
| Claude open, no watcher                         | **Open and rejoin**                            | no watcher                                             | the conversation comes to the front; paste                                       | choose it, paste                          | D                                        |
| The computer slept                              | **Rejoin**                                     | the watcher calls again                                | back                                                                             | Open its conversation                     | P (Claude, about 12 hours), ? (Codex)    |
| The computer restarted                          | **Open and rejoin**                            | neither app nor watcher                                | as closed                                                                        | as closed                                 | E                                        |
| Konfab restarted or updated                     | **Rejoin**                                     | its own state; the watcher calls again                 | back; one sent before is unsure                                                  | Rejoin again                              | P (Claude), E (Codex)                    |
| Room paused                                     | **Resume and rejoin**                          | paused                                                 | resumed, then as above                                                           |                                           | E                                        |
| Room on a break                                 | **End the break and rejoin**                   | on a break                                             | the break ends by the click, then as above                                       |                                           | E                                        |
| Usage limit                                     | **Rejoin**                                     | only if the agent reported it                          | ?                                                                                | Rejoin again later; Open its conversation | ?                                        |
| The app asks something                          | **Rejoin**                                     | nothing, or "waiting for approval" in the room         | waits for the answer in the app                                                  | **Open its conversation**                 | E                                        |
| Error or crash in the app                       | **Rejoin**                                     | no contact                                             | ?                                                                                | Open its conversation, paste              | ?                                        |
| Request delayed past 10 minutes                 | nothing more                                   | expired                                                | a late one is answered "closed"; nothing changes                                 | Rejoin again                              | E; P (late prompt refused, isolated run) |
| Cancelled                                       | **Cancel**                                     | cancelled                                              | the same                                                                         | Rejoin again                              | E                                        |
| Superseded: a second Rejoin, or a pasted prompt | **Rejoin** again (asks first)                  | the newest only                                        | only the newest can join; the old one is closed                                  |                                           | P (pasted prompt), E                     |
| Asked to stop, nothing heard                    | **Keep in room**, or **Open its conversation** | no call since 18:38                                    | the lead looks in the app                                                        | paste (warned)                            | E                                        |
| In a long command, not away                     | **Open its conversation**                      | working, no update                                     | the lead looks; nothing is sent                                                  |                                           | E                                        |
| Old connector, or no conversation known         | **Copy prompt and open the app**               | the last join named none                               | paste; then everything above                                                     | restart the connector                     | E                                        |
| Conversation archived or deleted                | **Open and rejoin**                            | maybe "refused"                                        | ?                                                                                | **Copy full prompt** for a new one        | ?                                        |
| Several, in mixed states                        | **Rejoin agents**                              | each of the above                                      | each on its own; those that need the lead are listed with their one button       |                                           | E                                        |

**"Back" means only one thing:** the new session's first wait that counts. Sent, taken, printed, opened and joined are shown as what they are.

### What was looked at

| Interface                                                                           | Result                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codex queue`                                                                       | adds a message. Its `--resume` speaks of a local daemon or a remote server, not of the app; no option resumes a paused queue, steers or withdraws                                                                                                                                                      |
| `codex://threads/<id>`                                                              | opens that conversation in the app                                                                                                                                                                                                                                                                     |
| Codex's app-server protocol (its own published description; marked experimental)    | has starting, steering and interrupting a turn, and reading a conversation's state. The app's server was **not reachable**: it talks to the app over its own pipes, and no control socket was found. Another server for the same conversation would run outside the window the lead sees: **not used** |
| `claude --desktop --resume <id>` (2.1.330)                                          | in its help and documentation: opens in the desktop app, with `--resume <id>` to pick the session. Not tried                                                                                                                                                                                           |
| `claude://` links                                                                   | documented for new Code sessions (a prompt filled in, not sent) and for chats, not for an existing Code session                                                                                                                                                                                        |
| Claude's hooks, `asyncRewake`                                                       | "wakes Claude on exit code 2 … even when the session is idle"; whether at the start of a conversation isn't said. Needs a Claude setting                                                                                                                                                               |
| A documented way to send a message into an open Claude session from another program | none found                                                                                                                                                                                                                                                                                             |

### Stale requests and doubled agents

- **One open request** per agent and room, and per conversation, as today. A second click shows the first; asking again closes it and says so.
- **Opening a conversation isn't a request.** It sends nothing and makes no session; it can be clicked as often as one likes.
- **A pasted prompt is an ordinary join.** It replaces the session and closes the open request in the same transaction, so a queued prompt that starts afterwards is answered "closed". This is the one case in which an agent has two prompts; the second costs a short turn and changes nothing.
- **Open and rejoin** for Codex sends first and opens then. If the opening fails, the request stays, and the card says that the conversation wasn't opened.
- **Resume and rejoin** and **End the break and rejoin** are two transactions: the room is changed first, as if by its own button, then the request is made by its own rules. If the second fails, the room stays resumed and the card says why there is no request. A request is never open in a paused room or a break, as today. Nothing but the lead's click ends a break here; a late prompt still never does.
- **Two conversations of one agent:** the newest session is the only one that can be asked; a call of the older is "replaced".
- **`claude --desktop --resume` must not make a second copy** of a conversation that is open. If the test by hand shows that it can, it isn't used, and the app is only brought to the front.

### The agent can say why it doesn't come back

`rejoin_room` gets an optional answer: the agent declines, because the user stopped it in its app. Konfab closes the request and the card says it within seconds instead of "Not back yet". It is only a message: it changes nothing else, and is accepted from the request's own app and conversation.

## Stop

| Wish                                     | Then                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One agent                                | **Stop agent** on its card, as today                                                                                                                             |
| All in a room, such as in the evening    | **Stop agents** in the header, beside **Rejoin agents**: shows first who is stopped now, who after a turn or work, and who isn't there; then each as on its card |
| To know that it is safe to leave         | one line: "2 of 2 agents stopped" or "codex: after this turn · claude: stopped"; with **Keep** until it is done                                                  |
| Pause                                    | after the click: "Agents go on waiting and use some allowance. To let them stop: **Stop agents**."                                                               |
| The app's own Stop, pressed all the same | the agent shows **No contact**; Rejoin leads on as above                                                                                                         |

**Stop agents, precisely.** One transaction per agent, not one for all: each is asked by the rules of [Stop agent](stop-agent.md), so a failure for one leaves the others asked. The answer lists each agent with what happened (stopped now, after its turn, after its work, not there, failed with its reason). It can be clicked again; who was asked is left as they are. It works in a paused room, isn't a break and doesn't pause. An agent that joins afterwards isn't stopped. **Keep in room** stays on each card, and **Keep all** undoes those that haven't stopped.

Break and "Stop agents" then do nearly the same. I'd keep both for now and ask after a few weeks whether **Take a break** is still used.

## What can be detected

| Known for sure                                                         | Only "if"                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| Whether the app is running (its process, by path)                      | whether a conversation is loaded or in front   |
| Whether Claude's watcher is there (an open call)                       | an interruption in Codex; its "Queue paused"   |
| Whether Codex took the prompt; whether the watcher printed             | a usage limit, a question in the app, an error |
| An agent's own words: "stopped in its app", "low allowance", "blocked" | whether the app's turn has ended               |
| Room paused, on a break, archived; window over; old connector          |                                                |

Codex writes its interruptions into its own files. Reading them would turn one "if" into "known", but their form isn't documented and they hold conversations. Not proposed.

## Decisions for the lead

1. **May a click on Rejoin count as your word to Claude also after you pressed Stop in Claude?**
   - **A. No, as now.** The card says at once that it was stopped there, and opens its conversation; you paste.
   - **B. Yes.** Your join prompt would say so in advance: "My click on Rejoin in Konfab is my own word, also after I have stopped you in this app." It is your page, only you can click it, the click comes after the Stop, and Konfab checks the request. Two limits: the app marks every wake-up as "not from the user", so a model may still hold back, and then A happens; and a Stop pressed in the same seconds as the click can be overtaken. It needs a test by hand before anybody relies on it.
   - I recommend **B, as an opt-in, if the test passes; otherwise A.** (Codex's queue is held by its app in both cases; Konfab can't and shouldn't change that.)
2. **May Konfab open the apps' conversations** when you click a button that says so?
3. **Stop agents** in the header?

## Phases

| Phase | What                                                                                                                                                                           | Depends on                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1     | the texts at once; never a dead button (copy the prompt and open the app); Resume and rejoin; End the break and rejoin; the agent's own answer; Stop agents; the hint at Pause | nothing unknown                                                              |
| 2     | Open the exact conversation, in both apps                                                                                                                                      | two tests by hand (below)                                                    |
| 3     | Claude after its own Stop (decision 1 B); Claude's watcher started by the app itself when the conversation is opened (a hook)                                                  | tests by hand; the hook changes a Claude setting, so only with the lead's OK |

## Tests by hand, with the lead

1. `claude --desktop --resume <id>`: with the app closed; open with another conversation; open with that one. Is it the same conversation, and does nothing get doubled?
2. `codex://threads/<id>` in the same three cases, with a waiting prompt, also after an interruption.
3. Decision 1 B: Stop in Claude, then Rejoin, three times, in a throwaway conversation.
4. The morning and the evening as a whole: Stop agents, sleep, Resume and rejoin; once with the apps' own Stop, once with the apps quit.

## Automated tests

Every row of the situations as the card shows it and as the server answers, with stand-ins for both apps' commands; every transaction as in the earlier designs; Stop agents with mixed states, a failure in between, a second click, a join in between, and two processes; the opening command with odd ids, missing apps and failures; no conversation id on the page; keyboard, themes, 375 px.

## Not included

Reading the apps' own files, pressing their buttons, changing their settings without a yes, sending anything by itself, and starting or bringing back agents at a time.
