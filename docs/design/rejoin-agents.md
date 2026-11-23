# Rejoin agents button

**Status:** proposal for review. Nothing is built. Evidence: [automatic rejoin](automatic-rejoin.md).

## Goal

The lead selects **Rejoin** on a Codex agent's card, or **Rejoin agents** for a room, and Konfab brings the agent back in the conversation it last joined from. The manual prompts always stay. Claude agents keep the manual prompts, because no supported way is known.

Konfab never does this by itself, and no agent can ask for it.

## What it relies on

| Fact                                                                                         | How it is known                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Codex names its conversation (`threadId`) in each tool call                                  | Seen with the CLI                                                  |
| `codex queue` adds a message to a conversation; one that is loaded and idle starts by itself | Seen, also in the app                                              |
| A conversation that isn't loaded takes the message when it is loaded                         | Seen, also in the app                                              |
| After **Stop**, the message waits until another turn has ended normally                      | Seen                                                               |
| An unknown conversation is refused, and nothing is queued                                    | Seen, in an empty temporary Codex folder                           |
| Queued messages can't be listed or withdrawn with the command                                | Its help lists no way                                              |
| A queued prompt leads to a real rejoin                                                       | Seen twice, with the app's server program; not in the app's window |

## The main danger: a prompt that arrives late

A prompt that Codex holds can be delivered hours later, for example right after the lead tells the agent to stop. The agent would then rejoin a room it was just told to leave, and a join also ends a break.

So the queued prompt doesn't say "join". It says to call a new tool, `rejoin_room`, with a one-time request number:

> Konfab: the lead asked you to rejoin room "…". Call rejoin_room with request "…" and follow its answer. If it says the request is closed, end your turn and do nothing else.

Konfab decides when that call arrives:

- **Wanted:** the request is open, less than 10 minutes old, not used, for this agent and this conversation, and the room can be joined. The answer is the same as from `join_room`, with the loop and permission rules.
- **Closed:** anything else. Nothing changes in the room. The answer is only that the request is closed and to end the turn.

A closed request costs one short turn. If the model ignores the instruction and calls `join_room`, that is an ordinary join, as with a pasted prompt; Konfab can't tell them apart, and this is a stated limit.

## Knowing the conversation

- On `join_room` and `rejoin_room`, the connector passes `threadId` from the call's metadata when the app is Codex and it is a UUID. It isn't a tool argument, so the model can't choose it.
- Konfab keeps it with the session, on this computer only. It is in no page, agent reply, export, activity entry or log; the page only learns whether a rejoin is possible.
- A program with the agent's own token could register another conversation. It would gain only this: if the lead then selects **Rejoin**, that conversation gets the fixed prompt above, and its request is refused unless it comes from the same conversation.

## Sending

- `codex queue --thread <UUID> --message=<prompt>`, started directly, without a shell; 15-second limit; the result is kept only as sent, refused or unknown.
- The command is found by setup: `rejoin.codex_command` in `config.yaml`, else the app's own copy on macOS. It must be an absolute path to a file that only this user or the system can change. `npm run doctor` says whether rejoin is available, and why not.
- It runs with the server's own home settings. An agent using another `CODEX_HOME` is refused by Codex as unknown.
- The prompt is the fixed text with the room's name and the request number. Nothing written in the room is in it.

## When it is offered

| Situation                                                                             | Button                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| The agent isn't waiting or working, its last join named a conversation, command found | **Rejoin**                                          |
| It is waiting or working                                                              | Not shown                                           |
| That conversation is waiting or working in another room                               | Disabled: "Its conversation is in another room now" |
| The room is archived, paused or on a break                                            | Disabled: says which; nothing is resumed for it     |
| Joined with an older connector, Claude, or no command                                 | Not shown; the manual prompts are                   |
| A request is open                                                                     | **Rejoin asked 12:03 · waiting** and **Cancel**     |

**Rejoin agents** in the room's header does the same for each agent it is offered for, after showing which and that it uses their allowance.

## States of a request

`sending` → `waiting` → `rejoined`, or `closed` (why: refused, cancelled, expired, replaced by another join, room changed).

- At most one open request per agent and room, and per conversation. Recorded before the command is started.
- **Refused** (the command said no): closed at once, with the manual prompts.
- **Unknown** (time limit, or Konfab stopped while sending): treated as waiting, because it may have been queued. It is never sent again by itself.
- After 60 seconds of waiting, the card says: "Not back yet. Open its conversation in Codex. If it was stopped with Stop, the prompt waits there until its next turn ends; paste the rejoin prompt instead."
- After 10 minutes it is closed as expired, also across a restart of Konfab.
- **Cancel**, an ordinary join by that agent, pausing, a break, archiving or removing the agent closes it. A copy that arrives later is answered as closed.
- After closing, the lead may ask again. An earlier copy that Codex still holds is closed by its number, so at most one is ever wanted; the card says an earlier prompt may still be waiting there.
- The agent counts as back only when it calls `wait_for_turn` after `rejoin_room`.

Activity shows "Rejoin asked", "Rejoined" and "Rejoin closed", without numbers.

## Not included

Starting or opening the Codex app, opening a conversation, starting by itself, Claude agents, changing approvals, reading Codex's own files, and withdrawing a queued message.

## Tests

- A stand-in command that records its arguments and can succeed, refuse, hang, or die; the same for a server killed at each step, then restarted.
- Every row of both tables; two clicks at once; two rooms with one conversation; a late, used, cancelled, expired, guessed, other-agent and other-conversation request; a break or pause between asking and arriving (a late prompt must not end a break).
- Room names with quotes, line breaks, a leading dash or instructions: one argument, and no second prompt line.
- The conversation's number and the request's number are in no page, export, log, activity or agent reply, apart from the request in its own prompt.
- Page: both buttons, waiting, not back yet, cancel, keyboard, both themes, 375 px.
- Real Codex, by hand with a throwaway room and conversation in the app: once each for loaded, not loaded, after Stop, late after expiry, and cancelled. Done only with the lead's OK, after checking the allowance.

## Questions for the lead

1. Is 10 minutes right for how long a request stays wanted?
2. Should **Rejoin agents** be shown as experimental until the app's own window has been tested?
