# Rejoin agents button

**Status:** built and marked experimental; one check in the app's own window has passed, the others are still to be done. Evidence: [automatic rejoin](automatic-rejoin.md).

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

> Konfab: the lead asked you to rejoin a room. Call the Konfab tool rejoin_room with request "K7…" and follow its answer. If it says the request is closed, end your turn and do nothing else.

This text is fixed. The request is 26 letters and digits made by Konfab, and names the room and agent by itself, so **nothing written by anyone, not even the room's name, is in the prompt**. The room's name comes only in the answer, where `join_room` gives it today.

Konfab decides when that call arrives:

- **Wanted:** every check below holds. The answer is the same as from `join_room`, with the loop and permission rules.
- **Closed:** anything else. Nothing changes in the room. The answer is only `{"status":"closed"}` and to end the turn; it doesn't say why, or whether the number ever existed.

A closed request costs one short turn. If the model ignores the instruction and calls `join_room`, that is an ordinary join, as with a pasted prompt; Konfab can't tell them apart, and this is a stated limit.

## One step, and races

`rejoin_room` does all of this in one immediate database transaction (it takes the write lock first), or none of it:

1. Find the request by the SHA-256 of its number; it must be `waiting` (or `sending`, if the call is faster than the command's own answer).
2. The calling app's token, agent and `_meta.threadId` must be the request's own.
3. It must be younger than its limit, by the server's clock at that moment.
4. The room isn't archived, paused (itself or all rooms) or on a break; the agent is still a member; its **newest session is the one the request was made for**, and neither that session nor another one of that conversation has called Konfab since. Such a call closes the request at that moment, so losing contact again doesn't make it wanted. (A restart of Konfab counts as contact with every agent for 90 seconds; that alone doesn't close a request. A session that has ended can't be in contact again; it is only told so.)
5. That conversation has no waiting or working session in another room.
6. Make the session, as `join_room` does, but **never ending a break**; mark the request `joined` with the new session's id.

Everything that can race takes the same lock, so one comes first:

| First                                          | Then                                                                                          | Outcome                                                                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cancel, expiry, pause, break, archive, removal | `rejoin_room`                                                                                 | closed; no session, the break and pause stay                                                                                                                                                   |
| `rejoin_room`                                  | Cancel                                                                                        | too late to cancel; the card shows "Joined · waiting for its first check"; pausing and breaks work as for any joined agent                                                                     |
| `rejoin_room`                                  | expiry                                                                                        | no effect; a joined request doesn't expire                                                                                                                                                     |
| An ordinary join by the agent                  | `rejoin_room`                                                                                 | closed: the newest session isn't the request's                                                                                                                                                 |
| Any other call by that session or conversation | `rejoin_room`                                                                                 | closed, also if its contact is lost again before the prompt arrives                                                                                                                            |
| `rejoin_room`                                  | an ordinary join                                                                              | the ordinary join replaces the session, as today; the request is closed as replaced                                                                                                            |
| `rejoin_room`                                  | a call by the old session                                                                     | it is told that it was replaced; the request stays `joined`                                                                                                                                    |
| `rejoin_room`                                  | the same call again (a retry by the connector after a lost answer, or the model repeating it) | **the same session** is answered, while it is still active and hasn't been replaced, for the same agent and conversation; otherwise closed. Never a second session                             |
| `rejoin_room`                                  | Konfab or the agent stops before the first `wait_for_turn`                                    | stays `joined`, never `back`. After 60 seconds: "Joined, but not waiting yet"; contact is lost after the usual time, and the manual prompts show. The lead can then ask again, which closes it |
| `rejoin_room`                                  | the room is paused or on a break before `wait_for_turn`                                       | that call is answered as for any agent in such a room; the request is `back` only if the call counts as waiting                                                                                |

`joined` (a session was made) and `back` (its first `wait_for_turn` was received) are different states, and only `back` is shown as success. `back` is recorded in the same transaction as that wait.

Stored receipts for retries keep the hash, not the number.

## Knowing the conversation

- The connector reads `_meta.threadId` of the `join_room` or `rejoin_room` call itself. Only for a client that names itself `codex-mcp-client`, and only if it is a lower-case UUID. It is not a tool argument. Anything else counts as **none**: no button, and `rejoin_room` is closed.
- `_meta` also has `sessionId` and other values in some calls; they aren't used. If `threadId` is missing in a Codex version, the feature is off there.
- Konfab keeps it with the session in its database (so also in database backups), on this computer only. It is in no page, agent reply, export, activity entry or log; the page only learns whether a rejoin is possible.

**It is a routing signal, not proof.** Where it can be wrong:

| Who                                                           | Can                                                                                                                                          | Can't                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| The model, through tools                                      | nothing: it doesn't set the metadata                                                                                                         |                                                                                |
| An agent that runs commands, or another program, as this user | read the connector's token and call Konfab as that app with any conversation number; run `codex queue` itself; read or change Konfab's files | be stopped by this feature: it already has all of that today                   |
| The same, with a false number                                 | make the lead's **Rejoin** put the fixed prompt in another of this user's conversations                                                      | put any text of its own in it through Konfab, or rejoin as another app's agent |
| The same, with a request number it has read                   | rejoin the room early as its own app's agent                                                                                                 | do it for another app's agent, after it is used, cancelled or expired          |

So the checks protect against mistakes and late prompts, not against a hostile program of the same user.

## Sending

- `codex queue --thread=<UUID> --message=<fixed prompt>`, started directly, without a shell, with no input, in an empty folder, and only the environment it needs (`HOME`, `CODEX_HOME`, `PATH` of the system). An agent using another `CODEX_HOME` is refused by Codex as unknown.
- Before it is started, the request is stored as `sending`.
- The command's arguments can be seen by this user's other programs while it runs. That includes the request number; see the table above.

**What the result means**

| Result                                                                                                                                                                | Request                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Exit 0 and output that has the line `Queued message … for thread <that UUID>`                                                                                         | `waiting`                      |
| Exit 1 and an error that names this thread and one of the refusals known for tested versions: `no rollout found for thread id`, or `No active session found matching` | `closed` (refused): not queued |
| It couldn't be started at all (no process was made)                                                                                                                   | `closed` (refused): not queued |
| Anything else: another exit code or text, both outcomes' text, a time limit, a signal, too much output, Konfab stopped meanwhile                                      | `waiting`, marked **unsure**   |

Only the two "refused" rows say "not queued". An unsure request is never sent again by itself; it can only be used, cancelled or expire. The output is matched and dropped; it is never stored, shown or logged.

## When it is offered

| Situation                                                                             | Button                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| The agent isn't waiting or working, its last join named a conversation, command found | **Rejoin**                                          |
| It is waiting or working                                                              | Disabled: "Available when the agent is away."       |
| That conversation is waiting or working in another room                               | Disabled: "Its conversation is in another room now" |
| The room is archived, paused or on a break                                            | Disabled: says which; nothing is resumed for it     |
| A Codex agent that joined with an older connector                                     | Disabled: says to restart it and join once by hand  |
| A Codex agent, and the command can't be used                                          | Disabled: says that doctor knows why                |
| Other apps, not joined, turned off, isolated, or not macOS                            | Not shown; the manual prompts are                   |
| A request is open                                                                     | **Rejoin asked 12:03 · waiting** and **Cancel**     |

**Rejoin agents** in the room's header does the same for each agent it is offered for, after showing which and that it uses their allowance.

## States of a request

`sending` → `waiting` (sure or unsure) → `joined` → `back`; or `closed` (refused, cancelled, expired, replaced, room changed) from any state before `back`.

- At most one open request per agent and room, and per conversation (unique in the database). A second click finds the first and changes nothing.
- After a restart of Konfab, `sending` becomes `waiting`, unsure. Nothing is started again.
- Expiry is checked when it matters (a call, the page), not only by a timer, so a sleeping computer doesn't extend it. Times before the request's own start (a changed clock) count as expired.
- The number is made with a secure random source (about 130 bits), compared by hash, and is in no page, log, activity, export or agent reply; only in its own prompt and the command's arguments.
- Pauses, breaks, archiving, removal, ordinary joins and the agent's own calls close a request in their own transaction, by database triggers. The service adds the time and the activity entry.
- Activity shows "Rejoin asked", "Rejoin joined", "Rejoined" and "Rejoin closed", without numbers.

### What the card says

| State                      | Text                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waiting`                  | Rejoin asked 12:03 · waiting. **Cancel**                                                                                                                                                                                                            |
| `waiting`, unsure          | Rejoin asked 12:03 · Konfab couldn't tell whether Codex took it. **Cancel**                                                                                                                                                                         |
| `waiting`, over 60 seconds | Not back yet. Open its conversation in Codex. If it was stopped with Stop, the prompt waits there until its next turn ends. You can paste the rejoin prompt instead; **the earlier prompt then stays in Codex and may start one short turn later.** |
| Cancel, before it is done  | **Cancel closes Konfab's request. It can't take back the prompt in Codex:** that may still start a short turn, which will be told to end.                                                                                                           |
| `closed`, not refused      | Rejoin closed. An earlier prompt may still be in Codex; it can start a short turn, but can't rejoin.                                                                                                                                                |
| `closed`, refused          | Codex didn't take it; nothing is waiting there. Use the rejoin prompt.                                                                                                                                                                              |
| `joined`                   | Joined · waiting for its first check.                                                                                                                                                                                                               |
| `joined`, over 60 seconds  | Joined, but not waiting yet. Look at its conversation in Codex, or paste the rejoin prompt.                                                                                                                                                         |
| `back`                     | The usual card: Waiting for a turn.                                                                                                                                                                                                                 |

The manual prompts are there in every one of these. **Rejoin** is offered again only after `closed`, or after `joined` once contact is lost; with an earlier prompt possibly still in Codex, it asks first: "Another prompt may already be waiting there. Send a new one? Only the newest can rejoin."

## What happens in each state of the Codex conversation

| Conversation                                    | Expected                                                                                              | Known from              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| Loaded, idle, last turn ended normally          | starts in seconds, rejoins                                                                            | seen                    |
| Not loaded, or the app closed                   | waits until it is opened; the card says so after 60 seconds                                           | seen                    |
| Interrupted (Stop)                              | waits for another turn to end normally; the card names Stop                                           | seen                    |
| Busy with something else                        | waits for that turn to end                                                                            | expected, to be tested  |
| After a usage limit or an error                 | may wait or fail again; the request expires                                                           | not known, to be tested |
| Archived or deleted in Codex                    | refused, or waits; either way nothing is sent elsewhere and the request expires                       | not known, to be tested |
| Its number is missing, not a UUID, or too old   | **Rejoin** isn't shown                                                                                | by design               |
| It was continued as a new (forked) conversation | the prompt goes to the conversation that joined, never to another; the request is refused from others | by design               |

Konfab never looks for another conversation, never falls back to a name, and never sends a second prompt by itself.

## Detecting the command

1. `rejoin.codex_command` if set (absolute path only); otherwise the app's own copy under `/Applications/ChatGPT.app` on macOS. Never a search through `PATH`.
2. The path is resolved once. The file must be regular and executable, and it and **every folder above it** must be owned by the system or this user and not writable by anyone else (an administrators' group counts as the system). Links are followed first and the resolved path is checked.
3. On macOS, the app's own copy must have a valid code signature with the identifier `codex` and the team `2DC432GLL2` (as on the tested app). A path from the setting skips this, and doctor says so.
4. `--version`, then `queue --help` naming `--thread` and `--message`, each within 5 seconds. They run with a temporary folder as `HOME` and `CODEX_HOME`, because the command writes to its own folder even then; only sending uses the user's.
5. Only versions on a short list that was tried (at first 0.171.x) are offered. **Any other version is off** until it is added or the lead sets `rejoin.allow_untested_version: true`.

This is done when Konfab starts, again before each use, and every 10 minutes while it can't be used. **Replacement in between:** after the checks, device, inode, size and modification time are compared once more just before starting. A change closes the request without starting anything. A tiny moment remains, and this user's own programs can replace the app at any time; that is the same boundary as above, not something these checks can stop.

On any failure the buttons aren't shown, the manual prompts stay, and doctor says which check failed.

## Defaults

| Setting                               | Default                   |
| ------------------------------------- | ------------------------- |
| `rejoin.enabled`                      | true, marked experimental |
| `rejoin.wanted_minutes`               | 10 (1 to 60)              |
| "Not back yet" after                  | 60 seconds                |
| Open requests per agent, conversation | 1                         |
| Automatic retries                     | none                      |

## Not included

Starting or opening the Codex app, opening a conversation, starting by itself, Claude agents, changing approvals, reading Codex's own files, and withdrawing a queued message.

## Tests

- **Races:** every pair in the race table in both orders, with the two sides started together against a real database file from two processes, many times; a fault after each statement of the transaction leaves nothing of it.
- **Lost answers and crashes:** the answer of `rejoin_room` lost and retried by the connector; the model repeating the call; Konfab killed before and after each state is stored and before the first wait. At most one session, and never `back` without a wait.
- **Late prompts:** used, cancelled, expired, guessed, another agent's, another app's, another conversation's, none, malformed and upper-case conversation numbers; a break or pause in between stays.
- **Results of the command:** every row, plus success text for another UUID, both texts at once, a refusal text with exit 0, success text with exit 1, endless output, a hang, a kill, no such file. Each is sent at most once.
- **The command:** writable file or folder at each level, another owner, a link to each, a changed file between check and start, a wrong signature, an untried version, missing options.
- **Prompt:** byte for byte the fixed text with the number, whatever the room, agent or topic is called.
- **Secrets:** the request number appears in clear only in its prompt and the command's arguments; the conversation number only in the database, its backups and the command's arguments. Neither is in any page, API answer, agent reply, log, activity, export or receipt.
- **Page:** every text above, both buttons, cancel, asking again, keyboard, both themes, 375 px.

### Acceptance checks

With the stand-in (automatic, every run):

1. A wanted request brings the agent back once; the card changes from asked to waiting to back, and only `wait_for_turn` makes it "back".
2. No situation in the tables sends to another conversation, sends twice by itself, or changes a room because of a late prompt.
3. A crash or restart at any step leaves at most one wanted request, and it still expires.
4. The manual prompts are there in every state.

With the real server program and a temporary Konfab (by hand): loaded, not loaded, after Stop, busy, and a late prompt after expiry.

In the app's own window (by hand, separate, with a throwaway room and conversation): loaded and idle; another conversation in front; the app closed and opened again; after Stop; cancelled before it arrives. Each is recorded as passed, failed or not run. The "experimental" mark stays until these pass. Both manual parts need the lead's OK and an allowance check first.

| In the app's own window              | Result                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Loaded and idle, turn ended normally | **passed**, once (2026-11-23, by the lead): joined after 19 seconds, back 5 seconds later, sent once |
| Another conversation in front        | not run                                                                                              |
| The app closed and opened again      | not run                                                                                              |
| After Stop                           | not run                                                                                              |
| Cancelled before it arrives          | not run                                                                                              |

## Remaining limitations

- A model that ignores the prompt and calls `join_room` joins as with a pasted prompt.
- A queued prompt can't be withdrawn; a late one costs a short turn.
- It needs the Codex app and a running Konfab on the same computer and account. Only macOS is tried; Linux and Windows aren't offered until they are.
- Codex may change `queue` or stop naming its conversation; then the buttons disappear.
- Agents need a connector restart for the new tool, as after any connector change.

## Decided by the lead

1. A request stays wanted for 10 minutes.
2. It is shown as experimental until the app's own window has been tested.
