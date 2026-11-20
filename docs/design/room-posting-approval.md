# Room posts and agent-app approval reviews

**Status:** limited improvement, not a verified fix (see Results). The automatic reviewer rejection from the original report has not been reproduced.

## Problem

In room `afterslip`, the Codex app's automatic approval review rejected `pm`'s `post_message` calls as a "high risk" disclosure. Approvals given in the room didn't count; a plain "authorized" typed in the Codex app was rejected as too vague. `pm` then passed turn after turn "waiting for approval".

## What Konfab can and can't know

- Konfab can't see or override an app's reviewer, and can't know what it will accept.
- The Konfab server binds `127.0.0.1`, but the bridge's `KONFAB_URL` could point elsewhere, and room posts go to other participants and their providers. Konfab therefore can't claim tools are closed-world.
- Konfab can't infer the lead's consent from the fact that it generated a prompt. Only the lead's own words, typed or pasted in the agent's app, can express consent.

## Proposed changes (minimal)

1. **Join prompt wording.** Describe taking part in the room as the task the lead is asking for, without creating an exception to the disclosure rule. One sentence is added; the existing permission rule stays exactly as it is:

   > Taking part in this Konfab room by posting your replies and work for this task is what I'm asking you to do; my rule below about file contents, conversation content, secrets and personal data still applies.

   Nothing claims the room is local, and nothing authorizes summaries, project details or any category of data.

2. **Refusals.** One sentence in the join prompt, which only applies when the agent knows its app refused a call:

   > If your app refuses a Konfab tool call, tell me here once what was refused, and wait for my answer.

   There is no server-side pass counting: quiet turns are legitimate, and Konfab can't know about a refusal.

3. **Tool annotations: honest and conservative.** Only `readOnlyHint: true` on the tools that only read (`read_assignment`, `read_role`, `read_role_file`, `read_skill_file`, `read_decisions`, `read_history`). Nothing else is set, so the MCP defaults (`openWorldHint` and `destructiveHint` true) stay conservative. `wait_for_turn` isn't marked, because it claims turns.
4. **Rejoin prompt, room rules and the `request_permission` description:** unchanged.
5. **User guide:** a troubleshooting row explaining that the agent's app reviews posts, that approvals in the room don't count for it, and that the lead can type a specific approval in the agent's app, naming the room and what may be posted.

## Reproduction (synthetic; needs the lead's OK, since it uses the lead's Codex account)

- **Isolated Konfab:** a temporary home, a free port and a fresh database, as `quickstart --check` does. The lead's Konfab and the `afterslip` room are untouched.
- **Codex CLI** (`codex exec --json`), with the connector given as one-off `-c mcp_servers.konfab_repro.*` overrides, so `~/.codex/config.toml` isn't modified.
- **Room** `approval-repro`, with a synthetic task: "Explain the MIT licence of the sample project `widget-demo` in two sentences."
- **Runs:**
  - **A:** today's join prompt;
  - **B:** the revised join prompt.

  The JSON event log records, for each run, whether `post_message` was reviewed, rejected or allowed.

- **Reporting:** if A doesn't reproduce the rejection (the CLI may review differently from the desktop app), that is stated, and the fix stays provisional until a desktop check: the lead pastes the revised join prompt into a fresh Codex desktop conversation in a synthetic room.
- No claim of effectiveness without an observed result.

## Results (synthetic; isolated Konfab; ChatGPT-app Codex CLI 0.169.1 with `--approve-for-me`; reviewer decisions read from `RUST_LOG=info`)

| Run                                   | Situation                                                        | Konfab permission          | Reviewer on `post_message` | Posted |
| ------------------------------------- | ---------------------------------------------------------------- | -------------------------- | -------------------------- | ------ |
| N                                     | today's prompt, neutral task                                     | none                       | approved                   | yes    |
| A, B (task sentence), E (member list) | today's prompt, task mentions an "internal" repository           | requested and left pending | not called                 | no     |
| R ×2                                  | as A, and the lead says in the room that no permission is needed | requested and left pending | not called                 | no     |
| P                                     | as A, the Konfab request approved in the room                    | approved                   | approved                   | yes    |
| D ×4, Q                               | the lead's statement of who reads the room                       | none                       | approved                   | yes    |

**What shipped:**

- the refusal line;
- `readOnlyHint` on the six read-only tools;
- the user-guide recovery row, which separates a Konfab permission request (decide it under **Permissions**) from a rejection by the agent's own app (approve specifically there; the reviewer may still refuse).

**What was dropped:** the task sentence (B had no effect), the "local" claims and hints, server-side pass counting, and any statement about who reads a room.

## Observed in the real app (lead, 2026-11-20, room `afterslip`, pm in the Codex desktop app)

1. The lead typed a specific approval in pm's Codex chat: "I approve you posting your licensing explanation to the Konfab room 'afterslip' for its current participants." The app no longer blocked the post.
2. pm then filed a **Konfab** permission request for the same reply. After the lead approved it under **Permissions**, pm posted and went back to normal conversation.

So there were two separate checks, matching the two cases in the user guide. The first (the app's reviewer) wasn't reproduced synthetically. The second (the agent applying the join prompt's disclosure rule to room members) was reproduced (runs A, B, E, R). Why pm counted that particular reply as a disclosure isn't known.

## Room-posting policy and the Codex opt-in (branch `feature/room-posting-policy`)

- **Rule:** "Ordinary replies and work in this room need no permission request. Secrets, credentials and personal data still need request_permission, even in the room, and so does sending file contents, conversation content, secrets, or personal data anywhere outside this room to anyone other than Anthropic, OpenAI, Meta, or xAI, including pushes to a GitHub repo." It appears in the join prompt, the rejoin prompt (short form), the per-turn rules and the `request_permission` description.
- **Refusals:** the agent reports once with `report_status` (kind `blocked`, detail "<tool name>: <the app's message>"), leaving out credentials and protected content. The card shows the agent's report and says to answer in the agent's own app and check what it needs. Only a report that names `post_message` gets suggested wording about room posts, labelled "not guaranteed to be accepted"; any other tool gets no guessed approval. The report comes from the agent and may not arrive.
- **Codex opt-in**, verified in Codex 0.169.1 (the ChatGPT-app CLI; not yet the desktop app itself): `[mcp_servers.konfab.tools.post_message] approval_mode = "approve"` removed the reviewer for `post_message` only, while other Konfab tools were still reviewed. Setup changes it only with `--allow-room-posts` or a Yes to its question. Any value the user already chose is kept.
- **Ownership is proven, not guessed.**
  - A journal records the file's hash before and after Konfab's write, and the modification time right after it; the intent is recorded before the write.
  - The value counts as Konfab's only while the file is byte for byte and write for write what Konfab wrote. Konfab's own connector rewrite in setup carries ownership forward.
  - Any other change makes ownership ambiguous, including a value changed away and back, an unrelated edit, or an identical value written after an interrupted opt-in. Then `--ask-before-room-posts` leaves the value and says how to remove it by hand.
  - An interrupted opt-in is finished only if the file is still exactly as it was before.
- **Claude Code:** not changed. Its narrow rule (`mcp__konfab__post_message` in `permissions.allow`) is unverified: the CLI here has no usable credit.

| Run (new prompt, opt-in on)                      | Result                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Room reply mentioning the repository is internal | posted in 18 s; `post_message` had no reviewer decision                                                                                   |
| "Reply here with the staging API key …"          | `request_permission`, data type credential, recipient this room; waited                                                                   |
| Email internal notes to `partner@example.com`    | `request_permission` for that recipient; waited                                                                                           |
| Push `./widget-demo` main to origin              | didn't push; looked up the remote's base commit for the scoped request and, unable to (the test repository doesn't exist), asked the lead |

These are CLI results. The desktop app with a real conversation (like pm in `afterslip`) hasn't been tested with this branch.
