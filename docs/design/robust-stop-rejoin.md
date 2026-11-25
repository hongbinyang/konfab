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

"Today" is what is on main. "Then" is with this proposal. **Seen**, _expected_ or _not known_ is said for what depends on an app.

| Situation                                             | Today                                        | Then                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent ended its turn, or **Stop agent**               | works (**seen** in both)                     | the same                                                                                                                                                               |
| Codex interrupted in its app                          | held silently                                | step 1; the card says at once: "If Codex shows 'Queue paused', select Resume there", with **Open its conversation**                                                    |
| Claude interrupted in its app                         | woken, doesn't use it, the card doesn't know | the agent **says so to Konfab** (below); the card: "You stopped it in Claude. Open its conversation and paste." Or, if the lead chooses it, it comes back (decision 1) |
| Codex closed, or its conversation not loaded          | waits up to 10 minutes                       | **Open and rejoin**: opens it, and the waiting prompt starts (**seen**)                                                                                                |
| Claude closed                                         | greyed out                                   | **Open and rejoin**: opens it; paste (_expected_). Later perhaps without a paste (phase 3)                                                                             |
| Computer asleep, then awake                           | works (**seen** for Claude, about 12 hours)  | the same; a request clicked before a sleep expires by the clock, and the card offers it again                                                                          |
| Computer restarted                                    | Codex waits; Claude greyed out               | as closed                                                                                                                                                              |
| Konfab restarted                                      | works (**seen**)                             | the same                                                                                                                                                               |
| Room paused                                           | greyed out                                   | **Resume and rejoin**                                                                                                                                                  |
| Room on a break                                       | greyed out                                   | **End the break and rejoin**; only this click ends it, never a late prompt                                                                                             |
| Run window over                                       | works                                        | the same                                                                                                                                                               |
| Usage limit reached                                   | _not known_                                  | if the agent reported it: "It reported a limit at 18:40." Otherwise among the "if" reasons. Rejoin can be asked again with one click                                   |
| The app asks something (a permission)                 | waits                                        | among the "if" reasons, with **Open its conversation**                                                                                                                 |
| Error or crash in the app                             | _not known_                                  | step 1; then open                                                                                                                                                      |
| Old connector, or the last join named no conversation | greyed out                                   | **Copy prompt and open the app**, and it says that the connector needs a restart                                                                                       |
| Conversation archived or deleted                      | _not known_                                  | refused or opened by the app; then **Copy full prompt** for a new one                                                                                                  |
| Agent is there but silent (a long command)            | not offered                                  | not offered; **Open its conversation** is, so that the lead can look                                                                                                   |
| Asked to stop, nothing heard                          | Keep in room, or the prompt                  | the same, with **Open its conversation** to press the app's own Stop there                                                                                             |
| Several agents                                        | **Rejoin agents**                            | the same for every agent that is away; those that need the lead are listed with their one button, one after the other                                                  |

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
