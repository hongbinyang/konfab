# Konfab: Requirements

**Status:** v1 shipped; later additions in sections 16 and 17
**Updated:** 2026-11-12

Priority levels:

- **MUST:** required for version 1 (v1)
- **SHOULD:** wanted in v1, but can slip without blocking it
- **LATER:** planned after v1

## 1. Goal

Give the user a simple, Slack-like chat on their Mac where they can create rooms, set each room's topic, and have AI desktop apps discuss it together. Agents can exchange ideas, debate, and review code using local resources.

**Design principle:** keep it practical and simple. If a feature does not help the first real conversations, it waits.

**Why build it:** research on 2026-11-06 found no existing app that lets agents take part through the installed Claude and Codex desktop apps and respond without being prompted. See `reports/AI agent group chat apps.md`.

### Out of scope for v1

- Connecting through a model provider's API or a model's CLI
- Measuring token use
- Grok, Muse, and any public connection to the room
- Starting or restarting agents automatically
- Multiple human users or access from other devices

## 2. Participants

| Participant | App | Role |
|---|---|---|
| User | Konfab web page | Super user: controls rooms, topics, and membership |
| Claude | `Claude.app` | Agent |
| Codex | `ChatGPT.app` (bundle ID `com.openai.codex`) | Agent |

## 3. Constraints

| ID | Priority | Requirement |
|---|---|---|
| C1 | MUST | Agents take part through their installed desktop apps and subscriptions. Konfab does not use provider APIs, API keys, or model CLIs. |
| C2 | MUST | Konfab, including its chat history, config, and logs, runs and is stored on the user's Mac. |
| C3 | MUST | Desktop apps may use public services and send data to their own providers. |
| C4 | MUST | Approved data recipients are Anthropic, OpenAI, Meta, and xAI. Sending data to anyone else requires the user's permission (section 9). |
| C5 | MUST | Agents may have full access to local resources. The user turns this on in each app. |
| C6 | MUST | New agents can be added through config, with no changes to Konfab's core code. |

## 4. Rooms and messages

| ID | Priority | Requirement |
|---|---|---|
| R1 | MUST | The user can create, rename, archive and permanently delete rooms (see RM1). |
| R2 | MUST | Each room has a topic set by the user, and agents receive it when they join. The user can change it at any time. |
| R3 | MUST | The user chooses which agents belong to each room, and can add or remove them. |
| R4 | MUST | Only the user can create rooms, change topics, or change membership. |
| R5 | MUST | Each room keeps its own ordered conversation, and agents can only read rooms they belong to. |
| R6 | MUST | History survives restarts of Konfab, the apps, and the Mac. |
| R7 | MUST | Each message records its sender, time, room, and any mentions. |
| R8 | MUST | Each agent has its own identity, so one agent cannot post as another. |
| R9 | MUST | Long content is limited to a configurable size. Agents refer to local files by path rather than pasting whole files. |
| R12 | MUST | The user is always the lead. Every turn tells agents to follow the lead's instructions and decisions. |
| R13 | MUST | The user can write a brief for each room, and a role for each agent in each room, on the web page. These apply from the agent's next turn, and Konfab's core rules always come after them. |
| R10 | SHOULD | Messages can be searched and exported. |
| R11 | LATER | Threads and reactions. (File attachments shipped in V5.) |

## 5. User interface

| ID | Priority | Requirement |
|---|---|---|
| U1 | MUST | A local web page shows a room list and each room's live conversation, and lets the user post messages. |
| U2 | MUST | The page shows each participant's status in the room. Agents: working, waiting for approval, idle, queued, on break, run window ended, not responding, or not joined. The lead: page connected or disconnected. |
| U3 | MUST | Each room has a ready-to-copy join prompt for each agent. |
| U4 | MUST | The user can pause and resume one room or all rooms, which stops or restarts new turns. |
| U5 | MUST | The page displays permission requests, and the user can approve or deny each one. |
| U6 | MUST | The page shows allowance warnings (section 7). |
| U7 | LATER | Mac notifications and config editing from the page. |

## 6. Joining and turns

Experimental parallel lead mentions are opt-in per room. They allow distinct agents to respond concurrently, subject to a room cap; ordinary turns remain serial. Busy-agent notices repeat until their turn begins and do not guarantee client delivery.


**Joining is manual in v1.** The user adds Konfab to each app once, then pastes a join prompt into a new conversation in that app.

| ID | Priority | Requirement |
|---|---|---|
| A1 | MUST | Agents connect to Konfab as an MCP server. Setup defaults to user-scoped desktop connectors, supports manual setup, and migrates existing project entries only explicitly. |
| S3 | MUST | Exhausted bridge outage retries report that the request was not confirmed and suggest continuing the loop after recovery, without guaranteeing the turn remains active. Authentication and validation errors keep their original messages. |
| S1 | MUST | Agents can report a one-line working detail of 1–120 characters per session, separate from turn state and allowance warnings. The card shows elapsed time and warns after `turn_timeout_minutes` without an update. Posting or passing clears it; updates and clears appear in the timeline. |
| A2 | MUST | Konfab provides tools to join a room, wait for a turn, post a message, pass on a turn, read history, report status, and request permission. |
| A3 | MUST | One app conversation joins one room. To join another room, the user starts another conversation, which keeps each topic's context separate. |
| A4 | MUST | A dropped agent can rejoin by pasting the join prompt again. It resumes from its last-seen message, without duplicate turns. |
| A5 | MUST | Within a room, one agent takes a turn at a time, except the lead's @mentions when a room enables parallel answers (TM4). |
| A6 | MUST | When the user posts without a mention, each room member gets a turn in order and may reply or pass. |
| A7 | MUST | An @mention gives a turn only to the named agents. Agents can @mention each other and the lead (`@lead`). Mentioning the lead gives no agent a turn and is highlighted on the page. |
| A8 | MUST | A turn includes every message that agent has not yet seen, up to a size limit. Older messages are available through history. |
| A9 | MUST | If an agent does not respond within a configurable time, Konfab skips it, records this, and tells the user. |
| A10 | MUST | The user's messages take priority over queued agent turns. |
| A11 | MUST | Each room allows at most 50 consecutive agent messages without a user message. This number is configurable. |
| A12 | SHOULD | Konfab tells agents to treat each other's messages as suggestions, not commands. |
| A13 | MUST | Review and debate formats schedule room-member slots and rounds, support lead controls, and propose a final decision without changing agent permissions. |
| A14 | LATER | Scheduled or computer-use rejoining, without the user pasting a prompt. |

## 7. Activity and allowance

| ID | Priority | Requirement |
|---|---|---|
| M1 | MUST | **Run window.** When an agent joins a room, at any time of day, it starts a run window of 5 hours by default. The length is configurable for all agents and for each agent. The card shows time remaining. Effective room/global pause freezes the balance and resume restores it without double-counting overlaps. Break saves each member’s balance for one subsequent join. Other rejoins start a fresh window; unpaused server downtime consumes time. |
| M2 | MUST | When an agent's run window ends, it receives no new turns. A turn already in progress may finish, and the agent then stops so it uses no allowance. The user can add 1 hour while running, paused or on break. Warnings at configurable thresholds (30, 10 and 5 minutes by default) have page Extend actions, optional browser notifications and persistent deduplication; extension above a threshold rearms it. Agents receive a low-time heads-up through their wait result at 10 minutes or less. |
| M3 | MUST | The user's messages are always accepted. Messages for an agent whose window has ended stay queued until it rejoins. |
| M4 | LATER | Continuous, Daily Message Limit, On Mention, and Scheduled modes, set per agent. |
| M5 | MUST | The user can start a break for one room or all rooms. Agents stop and use no allowance until the user rejoins them. Pause alone does not save allowance. |
| W1 | MUST | Konfab does not measure token use. |
| W2 | MUST | The starter prompt tells agents to report through Konfab if they know they are close to or out of allowance, and the page shows that report. |
| W3 | MUST | When an agent stops responding, the page says that it may be out of allowance and that the user should check its app. |
| W4 | SHOULD | If an app exposes remaining allowance to its agent, the agent includes that in its report. |

## 8. Local access and code changes

| ID | Priority | Requirement |
|---|---|---|
| F1 | MUST | Agents use their own apps' file and command tools. Konfab does not provide file or command tools. |
| F2 | MUST | The user guide explains how to turn on each app's full-access mode, and the user does this themself. |
| F3 | MUST | The user can mark which agents in a room may edit files and repos. Other agents are told not to edit them. |
| F4 | SHOULD | Each agent commits its code changes to its own git branch. |
| F5 | MUST | The user guide recommends Time Machine and frequent git commits, so changes can be undone. |
| F6 | MUST | Any room member with a live session can acquire an advisory write lock to coordinate shared resources. Locks expire and can be force-released by the lead; they do not grant editing permission or enforce filesystem or network access. |

## 9. Third-party data permission

Permission is required before an agent sends any of the following to a recipient other than Anthropic, OpenAI, Meta, or xAI:

- Local file contents
- Room conversation content
- Credentials or other secrets
- Personal data

Searches and downloads that contain none of these are allowed.

| ID | Priority | Requirement |
|---|---|---|
| P1 | MUST | The starter prompt states this rule, and Konfab repeats it to agents. |
| P2 | MUST | Before such a send, an agent uses the permission tool to state the recipient, the data, and the reason. |
| P3 | MUST | The agent must wait for the user's answer. With no answer, the request stays pending and the send does not go ahead. |
| P4 | MUST | Each approval covers only the stated recipient and data. |
| P5 | MUST | Konfab logs every request and answer. |
| P6 | MUST | The user can keep a list of pre-approved recipients and data types, including pushes to the GitHub repos the user lists. |
| P7 | MUST | Unless the user approves it, Konfab itself sends nothing to other third parties, and uses no analytics or external web assets. |

**Enforcement limit:** Konfab cannot see or block what agents do through their own apps. P1 to P4 rely on agents following instructions, so they reduce the risk but do not guarantee compliance. v1 does not include a firewall.

## 10. Security and reliability

| ID | Priority | Requirement |
|---|---|---|
| S1 | MUST | Konfab listens only on the Mac's loopback address. |
| S2 | MUST | Each agent and the web page must authenticate to Konfab. |
| S3 | MUST | Konfab rejects requests from unapproved websites, so a web page open on the Mac cannot control it. |
| S4 | MUST | Konfab logs messages, turns, skips, pauses, and permission requests, but never tokens or other Konfab credentials. |
| S5 | SHOULD | Konfab starts automatically when the user logs in. |

## 11. Technical approach

| Area | Choice | Why |
|---|---|---|
| App type | Local web page | Works in any browser, updates easily, and needs no Mac app packaging or signing |
| Language | TypeScript on Node.js | One language for the server and page, with an official MCP SDK |
| Server | Fastify | Small, well-known web server |
| Page | React with Vite | Fits a live chat page and has a common tool set |
| Live updates | Server-Sent Events | Simpler than WebSockets, since posts can use normal requests |
| Storage | One SQLite file | No database server to run, and easy to back up |
| Agent connection | MCP over stdio, through a small bridge | One connection path for all agents, including apps that cannot reach a local HTTP server |
| Environment | Project conda environment | Keeps Node separate from other projects and the system |

One local server holds all state, and each app starts a small bridge process. See [DESIGN.md](DESIGN.md). A desktop wrapper can be added later if the browser becomes limiting.

## 12. Known limitations

| ID | Limitation |
|---|---|
| L1 | Konfab cannot open an app or start an agent, so the user joins each one manually. |
| L2 | The Mac must stay awake with the apps open while agents are in a room. |
| L3 | Apps may limit how long a turn can stay open, so agents may drop out and need rejoining. |
| L4 | Konfab can only report allowance when an agent reports it or stops responding. An agent that is fully out of allowance may be unable to report anything. |
| L5 | Full access has no approval step, so a harmful instruction from a web page, file, or another agent could be carried out and affect anything on the Mac. |
| L6 | Rules for third-party data, roles, and editing rely on agents following instructions. |
| L7 | Model behavior varies, so an agent may ignore instructions or stop calling Konfab's tools. |

## 13. Feasibility checks

| ID | Check | Why it matters | If it fails |
|---|---|---|---|
| T1 | Can Claude and Codex each connect to a local MCP server from the desktop app? | Basic connection | Try local HTTP, then reconsider the approach |
| T2 | How long can each app keep waiting on a tool call or looping through repeated calls? | Determines how often agents drop out | Shorter sessions and more frequent rejoining |
| T3 | Does full-access mode remove every approval prompt during a session? | A prompt would stall an agent | Document which prompts remain |
| T4 | Does each agent keep following Konfab's rules after many turns? | Rules are instruction-based | Repeat the rules with each turn |
| T5 | Can each agent see its own remaining allowance? | Determines how useful W2 and W4 can be | Rely on W3 |

## 14. Delivery phases

**Phase 0: Prove the connection**

- Connect Claude and Codex to a minimal room using a new throwaway test repo.
- Complete T1 to T5.
- Done when both agents hold a multi-turn conversation, with measured results for how long they stay connected.

**Phase 1: Version 1**

- Build all MUST requirements.
- Done when:
  - The user creates two rooms with different topics and members, and agents join each using the copied prompts.
  - Both agents complete a real code review through a room.
  - Agents reply in order to an unaddressed message, and only the named agent replies to an @mention.
  - An agent stops receiving new turns when its run window ends, and its queued messages arrive when it rejoins.
  - Pause stops new turns in one room and in all rooms.
  - A test request for third-party data appears on the page, and the send waits for the user's answer.
  - An agent that stops responding triggers a warning, and it rejoins without duplicate turns.
  - The history survives a Mac restart.

**Phase 2: After real use**

- Add LATER items in the order the user chooses.
- Reconsider Grok, Muse, and any public connection at that point.

## 15. Decisions

| ID | Question | Decision |
|---|---|---|
| D1 | What is the app called? | Konfab. On 2026-11-06, the npm name looked unused, but `konfab.com` and `konfab.io` responded, and one small GitHub project uses the name. No trademark search has been done. |
| D2 | Which language is used? | TypeScript |
| D3 | Does v1 keep Daily Hours now that joining is manual? | Replaced on 2026-11-08 by the user with a run window of 5 hours by default that starts when an agent joins (M1). |
| D4 | How long are history and logs kept? | Until the user deletes them |
| D5 | What is in v1.1? | Emoji input, activity timeline, inline approval cards, and a decisions log, built in that order. Approved by the user on 2026-11-08. Reactions stay LATER. |
| D6 | What is the limit on consecutive agent messages? | 50 by default, raised from 5 to 20 and then to 50 by the user on 2026-11-08, so milestones and critical decisions still return to the lead. |

## 16. Version 1.1

**Status:** Approved by the user on 2026-11-08
**Build order:** V1 Emoji, V2 Activity timeline, V3 Approval cards, V4 Decisions log

Each feature is built on its own branch and must pass `npm run check`. It is then reviewed, and pushed only after the user approves the push.

### V1. Emoji input

| ID | Priority | Requirement |
|---|---|---|
| E1 | MUST | The message box has an emoji button that opens a picker with categories and search. |
| E2 | MUST | Choosing an emoji inserts it at the cursor, or replaces the selection, without disturbing other text or undo. The picker closes with Escape or by clicking outside it. |
| E3 | MUST | Emoji in messages from the user and agents display correctly on the page, in search results, and in exports. |
| E4 | MUST | Emoji data and images are bundled locally. The page loads nothing from a CDN or other external source (P7). |
| E5 | MUST | The picker can be used with the keyboard alone, and its buttons have accessible names. |
| E6 | SHOULD | Typing `:` and at least two letters suggests matching emoji by shortcode, such as `:thumbsup:` for 👍. |
| E7 | LATER | Reactions on messages (see R11). |

**Done when** the user can add several emoji to a message at different places, send it, and see it unchanged after a reload, in search, and in a Markdown export.

### V2. Activity timeline and connection measurements

| ID | Priority | Requirement |
|---|---|---|
| TL1 | MUST | Each room has a timeline of joins, rejoins, turns given, passes, timeouts and skips, inferred losses of contact, pauses, breaks, and status reports, with times. |
| TL2 | MUST | A loss of contact is shown as inferred, because Konfab sees only missing calls, not a disconnect. |
| TL3 | MUST | For each agent in the room, the page shows its last contact, its longest observed wait, and its median time to answer a turn. |
| TL4 | MUST | Konfab does not show or estimate allowance use (W1). |
| TL5 | MUST | Timeline data stays on the Mac and is included in the room export. |
| TL6 | SHOULD | The timeline can be filtered by agent and by event type. |

**Done when** a lead can tell from the page, after an agent drops and rejoins, when contact was last seen, how long the longest wait lasted, and when it rejoined.

### V3. Inline approval cards

| ID | Priority | Requirement |
|---|---|---|
| AP1 | MUST | A pending permission request appears as a card in the room's conversation, with Approve and Deny buttons, as well as in the existing list. |
| AP2 | MUST | The card shows the recipient, the data, the reason, and the requesting agent. |
| AP3 | MUST | A `code_push` request must state the repository, branch, and commit range. Konfab rejects one that does not. |
| AP4 | MUST | An approval covers only the stated scope. The agent is told to check that the scope is unchanged before pushing, and to ask again if it has changed. |
| AP5 | MUST | Answering a card uses the same record and log as the existing flow (P5), and the card then shows who answered, the answer, and the time. |
| AP6 | MUST | A card can be answered only from the user's authenticated page (S2, S3). |

**Done when** an agent's push request appears in the conversation, the user approves it there, and the agent's next turn shows the approval for exactly that commit range.

### V4. Decisions log

| ID | Priority | Requirement |
|---|---|---|
| DL1 | MUST | The user can mark any message as a decision, or write one directly. Agents can propose decisions, and a proposal applies only after the user confirms it. |
| DL2 | MUST | Each room shows its current decisions in a pinned panel, with links to the source messages. |
| DL3 | MUST | The user can revise or replace a decision. Earlier versions are kept and marked as replaced. |
| DL4 | MUST | Each turn includes the room's current decisions, up to a configurable size. When they exceed it, the turn says so and agents can read the rest through a tool. |
| DL5 | MUST | Only the user can confirm, revise, or replace decisions (R4). |
| DL6 | SHOULD | Decisions are included in the room export. |

**Done when** the user confirms an agent's proposal, revises it later, and each agent's next turn shows only the revised decision.


### V5. Local file attachments

| ID | Priority | Requirement |
|---|---|---|
| AT1 | MUST | The lead can paste an image, drop files, or use an attachment button, preview and remove files, then send with or without text. |
| AT2 | MUST | Files remain local under the Konfab data directory, with a configurable per-file limit of 10 MB by default. |
| AT3 | MUST | Messages show safe raster previews and downloadable files; filenames are searchable and exports link to local files. |
| AT4 | MUST | Room members receive attachment paths, detected type, and size in message metadata; file contents are not embedded in the bridge messages. |
| AT5 | MUST | Only the lead can upload attachments. Downloads require the authenticated page, and unsafe types are downloads rather than inline content. |

**Done when** a pasted image and an attached file survive sending and reload, and a room member can locate each file.

## Right panel usability

| ID | Priority | Requirement |
| -- | -- | -- |
| RU1 | MUST | Lead, Permissions, Decisions and Agents can collapse independently; the whole right panel can collapse and defaults closed below 900 px. Browser preferences persist across rooms with safe fallbacks when storage is unavailable. Pending permissions force their section and the panel open without changing saved preferences. Allowance warnings and stale working status open Agents and show a warning badge when the panel is collapsed. |
| RU2 | MUST | Agent status, warnings and compact actions stay visible; role and statistics are under Details. Decision creation is disclosed on request and long decision text can expand. Toggles support keyboard activation and expose expanded state. |

## Unread messages

| ID | Priority | Requirement |
| -- | -- | -- |
| RU3 | MUST | A fixed New messages divider and soft unread highlight identify unseen agent replies. Visibility in a focused tab records reads in bounded batches. Server cursors plus sparse seen IDs preserve skipped unread messages across tabs and restarts. Own posts mark earlier messages read; Mark all read and Esc outside forms are available. Existing messages form the initial upgrade baseline. |
| RU4 | MUST | Room badges and tab title show unread counts; lead mentions have an attention badge. Scrolling up preserves position and exposes a jump pill when unread messages exist. Backlogs beyond 500 messages have an explicit older-unread load action. |

## Explicit handoffs

| ID | Priority | Requirement |
| -- | -- | -- |
| RH1 | MUST | An agent post with no other agent recipient and no queued continuation returns a routing warning with a repair hint. Replays return the same post result. The hand_off tool lets the author of the room’s latest agent message, within 10 minutes, explicitly queue another live member. It refuses pause, break, archive, unavailable targets and the agent-streak limit. The original post already counts toward that limit; repair never bypasses it. Source/target repeats return the same turn, including after restart. |
| RH2 | MUST | The page shows active and queued recipients, including repaired routing, and neutrally indicates when no continuation is queued. Explicit Ask-to-continue buttons post an auditable user request. Suspension and fresh reported background work suppress the no-continuation prompt. No language heuristics or automatic recipient guessing are used. Repairs appear in the Activity timeline. |


## Automatic continuation

| ID | Priority | Requirement |
| -- | -- | -- |
| AC1 | MUST | Agent posts can explicitly continue themselves, hand off to an agent, wait for the lead, or finish. Existing mention routing remains compatible. |
| AC2 | MUST | A bounded, cancellable per-room watchdog recovers unaddressed legacy posts. It respects pause, break, approvals, streak limits and run windows, and stops after three automatic recoveries in an hour. |
| AC3 | MUST | Working heartbeats refresh the owning active turn; a timeout can be recovered once. Routing receipts, pending plans and caps survive restart. |

## 17. Version 1.2

Added from 2026-11-09 to 2026-11-12, each feature agreed with the user in the project room. Design notes for each are in [docs/design](docs/design/).

### V6. Connector setup

| ID | Priority | Requirement |
| -- | -- | -- |
| CS1 | MUST | `npm run setup` adds a user-level `konfab` connector to both apps by default, edits only that entry, backs up changed files and is idempotent. `--manual` writes instructions instead; `--rotate` issues new tokens; `--migrate <folder>` removes an old project `.mcp.json` entry. Existing tokens are reused, never silently rotated. |

### V7. Skill library and role packs

| ID | Priority | Requirement |
| -- | -- | -- |
| SL1 | MUST | Personal (`~/.konfab/skills`) and project (`<project>/.konfab/skills`) libraries manage standard Agent Skills folders. Untracked folders can be adopted. |
| SL2 | MUST | Skills can be created, duplicated, edited, renamed, saved as complete revisions, restored from history and moved to Trash when unused. External edits are drafts; conflicting edits are rejected. |
| SL3 | MUST | Review is recorded per saved revision; new revisions begin unreviewed. Konfab stores scripts as files and never runs them. |
| SL4 | MUST | A role pack is a `ROLE.md` plus pinned, reviewed skill revisions and per-room notes. Roles are instructions only and grant no permissions. Agents can read their role and bounded supporting files on demand. |
| SL5 | MUST | Existing custom role text can be previewed and converted into personal role packs, with optional assignment and conflict-checked restoration. |

### V8. Choose a role (role picker)

| ID | Priority | Requirement |
| -- | -- | -- |
| RP1 | MUST | **Change role** on a member card opens one window that searches the user's roles, personal skills, project skills and enabled public sources, with combinable filters, location hints and helpful empty states. |
| RP2 | MUST | A preview shows instructions, files, licence and the source commit. **Review & assign** approves and pins exactly that revision and assigns it in one transaction; **Customize** saves an editable copy (personal or project), then assigns it. |
| RP3 | MUST | Public sources are searched on demand: names first, then descriptions loaded into memory only. Nothing is stored until assign or customize, and then only that skill, verified against the source commit. **Update available** or **Removed from source** never changes an assignment automatically. |
| RP4 | MUST | GitHub requests use an in-memory cache, conditional requests and rate-limit tracking; a limit shows its reset time and keeps loaded results. An optional token, stored in macOS Keychain or the `KONFAB_GITHUB_TOKEN` environment variable, is sent only to `api.github.com` after the user enables it, is never logged, and never falls back to anonymous access when rejected. **Check GitHub status** shows the result. |
| RP5 | MUST | **⚙ Manage library** replaces the Library navigation entry for editing skills and roles, managing sources and the token, and removing old downloaded indexes after confirmation. |

### V9. Teams and parallel work

| ID | Priority | Requirement |
| -- | -- | -- |
| TM1 | MUST | The lead can stage swaps, rotations, assignments and removals of roles for any number of members and apply them atomically; a stale change applies nothing. Notes move with the role; edit access stays with the member. A system handover message records the change. |
| TM2 | MUST | An agent mid-turn keeps its previous role until its next turn. The next turn carries a one-time notice for a first assignment, a change, notes-only edits or a removal. |
| TM3 | MUST | An app credential can own several named agents (default limit four, configurable). Each session is bound to its agent and authenticated app; an app cannot act as another app's agent; calls without a session are rejected. |
| TM4 | SHOULD | With the per-room setting on (off by default), the lead's @mentions give waiting agents an immediate parallel turn, at most three per room. A busy mentioned agent gets a repeated note at its next Konfab call and a queued turn. Unaddressed posts, handoffs and format steps stay serial; an agent never has two active turns. |
| TM5 | MUST | Busy agents are asked to check in with a working status at a per-room interval (1, 2, 5 or 10 minutes; default 2, configurable). Check-ins are cooperative; the member card shows queued mentions and the latest later status. |

### V10. Rooms and quality

| ID | Priority | Requirement |
| -- | -- | -- |
| RM1 | MUST | The lead can permanently delete an archived room after typing its name. All room data and its attachment folder are removed in one transaction plus tombstoned file cleanup, room IDs are never reused, the database is compacted, and a content-free audit line is kept. |
| RM2 | MUST | Decision cards show their numbers, and `#N` references link to the card. |
| RM3 | MUST | Typing in the message box stays responsive in long rooms (measured under 5 ms per keystroke with 500 long messages). |
| RM4 | MUST | After a server restart, an open page offers to reload. |

### Proposed: Room agent names

These requirements are under review and are not yet implemented.

| ID | Priority | Requirement |
| -- | -------- | ----------- |
| AN1 | MUST | The lead can set a room-specific name when defining an agent, including a default agent. Before the agent first joins that room, the lead can change or clear its name; clearing restores existing display name and ID behavior. On first join the name is fixed in that room, including after removal and re-addition. Other rooms are unaffected; archived rooms are read-only. Agents cannot rename themselves or other members. |
| AN2 | MUST | The lead-given room name is the name used to mention the agent. It uses the existing mention syntax; reject an invalid name with an explanation. The page shows the exact mention and explains when a name is fixed. Agents receive current member names on their next turn or wait result. |
| AN3 | MUST | Case-insensitive name mentions route to the intended member in lead and agent messages, handoffs, availability notices and parallel mentions. Existing ID mentions remain valid aliases; `@lead` and `@all` keep their meanings. Sessions, identities, join behavior and existing integrations remain compatible. |
| AN4 | MUST | Reject reserved names `lead` and `all` and ambiguous names, including case-insensitive conflicts with another member's name or ID and conflicts introduced when adding a member. A member may use its own ID as its name. Give an actionable error; never silently choose a recipient. A removed member retains its room name if re-added, unless it would conflict, in which case the add is rejected. |
| AN5 | MUST | Names never alter the recipients or text of earlier messages. Room views show the room name for the member, including message senders, cards, status, availability, team and format controls and continuation controls. Elsewhere the existing display name remains in use. A member without a room name retains existing behavior. |
| AN6 | MUST | The page does not present the standalone default-agent marker as a name; the app and agent identity remain discoverable. |
| AN7 | LATER | Mention autocomplete, global names and changing agent IDs. |
