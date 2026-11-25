# Konfab: Requirements

**Status:** Current requirements include the shipped additions in sections 16–22.
**Updated:** 2026-11-23

Priority levels:

- **MUST:** required behavior for the applicable release or feature
- **SHOULD:** desired behavior that can be deferred
- **LATER:** not yet required

## 1. Goal

Give the user a simple, Slack-like chat on their Mac where they can create rooms, set each room's topic, and have AI desktop apps discuss it together. Agents can exchange ideas, debate, and review code using local resources.

**Design principle:** keep it practical and simple. If a feature does not help the first real conversations, it waits.

**Why build it:** research on 2026-11-06 found no existing app that lets agents take part through the installed Claude and Codex desktop apps and respond without being prompted. See `reports/AI agent group chat apps.md`.

### Out of scope for v1

- Connecting through a model provider's API or a model's CLI
- Measuring token use
- Grok, Muse, and any public connection to the room
- Starting or restarting agents automatically (the lead can ask for it; section 23)
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
| C1 | MUST | Agents take part through their installed desktop apps and subscriptions. Konfab does not use provider APIs, API keys, or model CLIs. The one exception is the app's own queue command, which hands a fixed prompt to a conversation of the app when the lead asks (section 23); it runs no model itself. |
| C2 | MUST | Konfab, including its chat history, config, and logs, runs and is stored on the user's Mac. |
| C3 | MUST | Desktop apps may use public services and send data to their own providers. |
| C4 | MUST | Sending the data types in section 9 to recipients other than Anthropic, OpenAI, Meta, or xAI requires the user's permission. |
| C5 | MUST | Agents may have full access to local resources. The user turns this on in each app. |
| C6 | MUST | The user can add named agents for supported desktop apps without changing Konfab's core code. Supporting a new app type may require connector and setup work. |

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
| R13 | MUST | The user can write a room brief and assign each member room instructions and skills on the page. Changes apply from the member's next turn; the lead's instructions and room rules take precedence (SA1–SA5). |
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
| U7 | LATER | Native Mac notifications and general config editing from the page. Optional browser notifications for run-window warnings are available (M2). |

## 6. Joining and turns

Experimental parallel lead mentions are opt-in per room. They allow distinct agents to respond concurrently, subject to a room cap; ordinary turns remain serial. Busy-agent notices repeat until their turn begins and do not guarantee client delivery.


**Joining is manual in v1.** The user adds Konfab to each app once, then pastes a join prompt into a new conversation in that app.

| ID | Priority | Requirement |
|---|---|---|
| A1 | MUST | Agents connect to Konfab as an MCP server. Setup defaults to user-scoped desktop connectors, supports manual setup, and migrates existing project entries only explicitly. |
| BR1 | MUST | Exhausted bridge outage retries report that the request was not confirmed and suggest continuing the loop after recovery, without guaranteeing the turn remains active. Authentication and validation errors keep their original messages. |
| ST1 | MUST | Agents can report a one-line working detail of 1–120 characters per session, separate from turn state and allowance warnings. The card shows elapsed time and warns after `turn_timeout_minutes` without an update. Posting or passing clears it; updates and clears appear in the timeline. |
| A2 | MUST | Konfab provides tools to join a room, wait for a turn, post a message, pass on a turn, read history, report status, and request permission. |
| A3 | MUST | One app conversation joins one room. To join another room, the user starts another conversation, which keeps each topic's context separate. |
| A4 | MUST | A dropped agent can rejoin by pasting a short rejoin prompt into the same conversation, or the full join prompt into a new one. It resumes from its last-seen message, without duplicate turns. |
| A5 | MUST | Within a room, one agent takes a turn at a time, except the lead's @mentions when a room enables parallel answers (TM4). |
| A6 | MUST | When the user posts without a mention, each room member gets a turn in order and may reply or pass. |
| A7 | MUST | An @mention gives a turn only to the named agents (by agent ID, or by room name per AN1–AN6). Agents can @mention each other and the lead (`@lead`). Mentioning the lead gives no agent a turn and is highlighted on the page. |
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
| P7 | MUST | Konfab uses no analytics or external web assets. Public skill search and the optional GitHub token operate only when the user enables or invokes them; the token is sent only to `api.github.com` as described in RP4. Other restricted disclosures require permission under P1–P4. |

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
| L6 | Rules for third-party data, skill assignments, and editing rely on agents following instructions. |
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
| RU2 | MUST | Agent status, warnings and compact actions stay visible; skill assignment and statistics are under Details. Decision creation is disclosed on request and long decision text can expand. Toggles support keyboard activation and expose expanded state. |

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

### V7. Skill library

SL4 and SL5 described the former role-pack system and are retired; see SA1–SA9 for its replacement.

| ID | Priority | Requirement |
| -- | -- | -- |
| SL1 | MUST | Personal (`~/.konfab/skills`) and project (`<project>/.konfab/skills`) libraries manage standard Agent Skills folders. Untracked folders can be adopted. |
| SL2 | MUST | Skills can be created, duplicated, edited, renamed, saved as complete revisions, restored from history and moved to Trash when unused. External edits are drafts; conflicting edits are rejected. |
| SL3 | MUST | Review is recorded per saved revision; new revisions begin unreviewed. Konfab stores scripts as files and never runs them. |
| SL4 | Historical | Former role-pack format, superseded by SA1–SA5. |
| SL5 | Historical | Former custom-role conversion, superseded by the upgrade in SA8. |

### V8. Skill selection and public sources

The former role picker was replaced by skill assignments (section 18).

| ID | Priority | Requirement |
| -- | -- | -- |
| RP1 | MUST | **Assign skills** searches personal, project, built-in and enabled public skills, with filters, location hints and helpful empty states (SA2). |
| RP2 | MUST | Skill previews show available instructions and files; public previews include licence and source commit. Confirmation reviews and pins the selected revisions (SA2). |
| RP3 | MUST | Public sources are searched on demand: names first, then descriptions loaded into memory only. Nothing is stored until assignment, and then only selected skills, verified against their source commits. New revisions never change an assignment automatically (SA4). |
| RP4 | MUST | GitHub requests use an in-memory cache, conditional requests and rate-limit tracking; a limit shows its reset time and keeps loaded results. An optional token, stored in macOS Keychain or the `KONFAB_GITHUB_TOKEN` environment variable, is sent only to `api.github.com` after the user enables it, is never logged, and never falls back to anonymous access when rejected. **Check GitHub status** shows the result. |
| RP5 | MUST | **⚙ Manage library** supports managing skills, sources and the optional token, and removing old downloaded indexes after confirmation. |

### V9. Teams and parallel work

_Skill bundles replace the former role assignments; see SA5–SA6._

| ID | Priority | Requirement |
| -- | -- | -- |
| TM1 | MUST | The lead can stage swaps, rotations, assignments and removals of skill bundles and room instructions atomically; stale changes apply nothing. Edit access stays with the member, and a system handover message records the change (SA6). |
| TM2 | MUST | An agent mid-turn keeps its previous assignment until its next turn. The next turn carries a one-time notice for a first assignment, a change, instruction-only edits or a removal (SA5). |
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

### Room agent names

Design: [room names for agents](docs/design/agent-names.md).

| ID | Priority | Requirement |
| -- | -------- | ----------- |
| AN1 | MUST | The lead can set a room-specific name when defining an agent, including a default agent. Before the agent first joins that room, the lead can change or clear its name; clearing restores existing display name and ID behavior. On first join the name is fixed in that room, including after removal and re-addition. Other rooms are unaffected; archived rooms are read-only. Agents cannot rename themselves or other members. |
| AN2 | MUST | The lead-given room name is the name used to mention the agent. It uses the existing mention syntax; reject an invalid name with an explanation. The page shows the exact mention and explains when a name is fixed. Agents receive current member names on their next turn or wait result. |
| AN3 | MUST | Case-insensitive name mentions route to the intended member in lead and agent messages, handoffs, availability notices and parallel mentions. Existing ID mentions remain valid aliases; `@lead` and `@all` keep their meanings. Sessions, identities, join behavior and existing integrations remain compatible. |
| AN4 | MUST | Reject reserved names `lead` and `all` and ambiguous names, including case-insensitive conflicts with another member's name or ID and conflicts introduced when adding a member. A member may use its own ID as its name. Give an actionable error; never silently choose a recipient. A removed member retains its room name if re-added, unless it would conflict, in which case the add is rejected. |
| AN5 | MUST | Names never alter the recipients or text of earlier messages. Room views show the room name for the member, including message senders, cards, status, availability, team and format controls and continuation controls. Elsewhere the existing display name remains in use. A member without a room name retains existing behavior. |
| AN6 | MUST | The page does not present the standalone default-agent marker as a name; the app and agent identity remain discoverable. |
| AN7 | LATER | Mention autocomplete, global names and changing agent IDs. |

## 18. Skill-based agent assignments

**Status:** Shipped on 2026-11-13. SL4–SL5 describe retired role behavior; the current assignment requirements are below. Design: [skill-based assignments](docs/design/skill-assignment.md).

Skills are the assignment concept: a skill can describe an agent's responsibilities as well as a procedure, and an agent can use a combination of skills. Skills remain standard Agent Skills folders stored locally; the product should simplify both its interface and implementation by removing the separate role model.

| ID | Priority | Requirement |
| -- | -- | -- |
| SA1 | MUST | The lead can assign an ordered combination of zero or more locally stored skills to each room member, with optional room-specific instructions. A skill may define responsibilities, a procedure, or both. Existing ordinary Agent Skills remain valid; no extra role format is required. Skills and instructions do not grant permissions. |
| SA2 | MUST | The assignment flow lets the lead find, preview, select, remove and order multiple personal, project and enabled public skills, and edit room instructions. Public selections are copied locally and verified before use. Show exactly what will be assigned, including source and revision, before confirmation. Confirming the displayed revisions records their review; unreviewed revisions are not delivered without that confirmation. Reject an assignment exceeding the supported delivery limit with an actionable explanation before it is applied. |
| SA3 | MUST | Each assignment pins exact saved skill revisions. Local edits are visible as drafts and can be saved as new revisions; local folders can be adopted and remote skills copied locally. Reassigning or updating an existing skill must not fail merely because a same-named assignment already exists. Name and content conflicts are explained; no unrelated files or revisions are silently overwritten. |
| SA4 | MUST | The lead can see when a newer saved revision is available and preview its changes, review it and explicitly update selected assignments. Provide a member-card update for that member and a skill-based update that lists affected members across rooms for selection. The confirmation identifies affected members and exact revisions, and records their review; other assignments stay pinned. Assignment never silently follows later edits or upstream changes. |
| SA5 | MUST | Agents receive the ordered assignment and room instructions on their next turn and can read the pinned skill instructions and supporting files. A change during a turn takes effect on the next turn, with an assignment-change notice; it must not alter the active turn's instruction snapshot. Room rules and lead instructions remain authoritative. |
| SA6 | MUST | The lead can atomically swap, rotate, assign and remove complete skill bundles and room instructions across members; stale edits apply nothing. Room instructions move with the bundle; room name, app identity, session and edit permissions stay with the member. Formats continue to work with skill assignments. |
| SA7 | MUST | Remove role as a separate user-facing assignment, management and storage concept, including built-in roles; provide equivalent built-in skills where needed. Preserve useful existing skill-library, review, provenance, revision, search and trash protections. A skill in use cannot be removed in a way that breaks a pinned assignment or active turn. Update the README, user guide, skills guide and agent-facing tool descriptions to reflect the new behavior, and mark superseded role requirements as historical when shipped. |
| SA8 | MUST | Upgrade existing installations without deleting rooms, messages, members, decisions, sessions or unrelated skills. Preserve the instructions and notes of each existing assignment, including free-text custom roles, roles with no skills and pinned supporting skills, as equivalent skill-based assignments. Preserve free-text role instructions in the member’s room instructions. Do not silently replace or discard role content on naming collisions. Preserve enough state for an in-progress turn to finish with its original instructions, or stop safely with a clear recovery path if that cannot be done. |
| SA9 | MUST | Existing connected agents must be able to finish their current work and continue after upgrade, including access to their active-turn instructions and supporting files. Clearly communicate any connector reload or rejoin that is actually necessary; do not claim seamless continuation without verifying it. |

### Acceptance checks

- Create and assign several skills, reorder them, inspect the delivered content, change an assignment mid-turn, and verify the next turn and its notice.
- Edit a tracked skill on disk; save, preview and review a new revision; update selected assignments while other members remain pinned. Reassign without a name-collision failure; test conflicts and rollback.
- Copy a public skill locally and assign it with a local skill; verify source/revision and that upstream or local changes do not silently change an assignment.
- Verify exact-revision review, delivery-size rejection and both update entry points. Exercise swaps/rotations, stale updates, in-use protection and a complete Format; verify room instructions move with bundles and edit permissions do not.
- Upgrade a representative old database with role text, pinned skills, notes, active sessions and an active turn; restart the actual service and database, complete or safely recover the turn, then verify the next turn and preserved room data. Cover name collisions and an assignment with no skills.
- Verify the assignment flow and migration in an isolated instance in both themes, with the required automated checks and a real connected-agent check where feasible.

### Resolved in the design

- **Order and conflicts:** room rules and the lead > room instructions > skills in list order; the earlier skill wins, and every full assignment tells the agent so.
- **Upgrade:** converts every role revision in use (including active-turn snapshots) into reviewed personal skills, keeps the old `role` reply until an assignment changes, writes a fresh backup per attempt, and stops without writing if an assignment cannot fit.
- **Updates:** per member from its card, or per skill across rooms for selected members; never automatic.

## 19. Import a local skill

**Status:** Implemented on `feature/local-skill-import`; in review. Design: [local skill import](docs/design/local-skill-import.md).

The lead can bring a skill from elsewhere on their computer into a personal or project library without manually creating a matching folder. Importing never assigns it to an agent.

| ID | Priority | Requirement |
| -- | -- | -- |
| LI1 | MUST | In **Manage library**, the lead can choose a single skill definition file (regardless of its source filename) or a skill folder for import into the personal library or an available project library. A folder import includes its supporting files. A single-file import clearly states that other files are not included. The selected definition becomes `SKILL.md` in the destination regardless of its original name. For a folder, prefer a root `SKILL.md`; otherwise let the lead identify the definition file, and never guess silently when the choice is ambiguous. Preserve all other selected files; if the destination `SKILL.md` would collide with a different supporting file, explain the conflict and require resolution rather than overwriting it. |
| LI2 | MUST | Before importing, show the chosen source definition file, skill name, instructions and file list, destination library, proposed folder and destination filename. The name is editable for every import, including when there is no collision. Validate the chosen name and show errors before confirmation. |
| LI3 | MUST | Create a local folder matching the chosen name. The imported definition is saved as `SKILL.md`. If the skill is renamed, update the `name:` field in that imported copy to match and show that change in the preview; do not alter the selected source files. Save a revision, record local-import provenance and preserve the manifest’s licence metadata. The imported revision starts unreviewed and is not assigned automatically. |
| LI4 | MUST | On a name collision, warn before any replacement and offer a separately named copy or explicit replacement. A replacement imports the complete package as a new revision of the existing skill; its earlier revisions remain recoverable, and existing agent assignments stay pinned until explicitly updated. Show the affected skill and its current users. Collisions are scoped to the chosen library; built-in skills are read-only and cannot be replaced, but their names may be used in another library. A trashed skill in that library also counts as a collision; offer a different name or restore it before replacement. A replacement records local-import provenance, including when the previous revision came from a public source. Do not silently overwrite unrelated folders, unsaved drafts or files. |
| LI5 | MUST | Detect stale destination state or a changed draft between preview and confirmation and require the lead to review again; do not overwrite it. If the destination is an untracked folder or cannot be safely replaced, explain the conflict and offer a different name. Failure, cancellation or an interrupted import must not leave a partial skill or destroy source, existing revisions or drafts. |
| LI6 | MUST | Validate the manifest, file paths and existing package-size limits before committing. Reject missing or invalid required fields, duplicate or unsafe paths and oversized packages with actionable errors. Skip `.DS_Store` files and `.git` directories and show them as excluded in the preview; show other included hidden files. Copy scripts as files only; never execute them. The design must verify what the chosen browser input exposes about symbolic links and document any limitation rather than claiming detection the browser cannot provide. |

Importing multiple skills at once and importing archives are out of scope for this feature. When a single-file import refers to files not included, the preview should warn when those references can be identified reliably.

**Acceptance checks**

- Import a single definition with an arbitrary filename and a folder with nested supporting files; verify the destination definition is `SKILL.md`. In a folder with multiple plausible definitions, require an explicit choice; preview both, choose the destination and confirm the matching folder and saved, unreviewed revision. No agent assignment changes.
- Rename an import with and without a collision; verify the preview and imported manifest agree, supporting files are intact, and the source files remain unchanged.
- Replace a tracked skill after a warning; verify the old revision can be restored, existing assignments remain pinned, and an unsaved draft or concurrent destination change is not overwritten. A collision with an untracked folder must not replace it. Cover a trashed skill, a built-in name in another library, and replacement of a skill previously copied from a public source.
- Cancel or force failure at each write stage, then restart the service and inspect the library: no partial import or loss of existing work. Exercise invalid manifests, duplicate or unsafe paths, package limits, excluded files, licence preservation and unavailable project libraries.
- Check the user flow in an isolated browser in both themes and run the repository's required checks, including browser tests for the page change.

## 20. Formatting while writing

**Status:** Implemented. Design: [message editor](docs/design/message-editor.md).

| ID | Priority | Requirement |
| -- | -- | -- |
| ME1 | MUST | Messages show basic Markdown: emphasis, strikethrough, inline and fenced code, lists, task lists, tables, quotes and links. Raw HTML and unsafe link targets are never rendered. Wide tables scroll inside the message. |
| ME2 | MUST | Bold, italic, strikethrough, inline code, links, lists and quotes show in the message box as they are written, through shortcuts, typed marks or an optional menu that is hidden until opened. |
| ME3 | MUST | What isn't formatted is sent exactly as typed. Markdown the box can't show (such as tables) is rendered live beside it. A message that would lose a format is reviewed, and can be corrected, before it is sent. |
| ME4 | MUST | Every format can be left: **Normal text** clears all of them, and ↓ or → at the very end leaves a list, a quote or an inline format. Elsewhere, arrows only move the cursor. |
| ME5 | MUST | Every formatting shortcut is listed in the app and the user guide, and a test compares the guide's formats with the editor's. |
| ME6 | MUST | Drafts and files are kept per room until the page is closed or reloaded. What is written or attached during a send, and a message that can't be sent, aren't lost when switching rooms or opening the library. |
| ME7 | MUST | A plain text box is always available and is the fallback if the editor can't load. |
| ME8 | LATER | Edit tables, task lists, headings and code blocks visually in the box. |

Not yet verified: Safari, Firefox, VoiceOver, real input methods, Windows, Linux and phones.

## 21. Bounded logs and updates

**Status:** Implemented.

| ID | Priority | Requirement |
| -- | -- | -- |
| LG1 | MUST | The server's log is kept in a fixed number of size-limited files that only the user can read. A problem with the log never stops Konfab. |
| LG2 | MUST | A login item's other output is bounded while it runs. Logs of earlier versions are never cut or deleted by Konfab. |
| LG3 | MUST | One process at a time writes and rotates a log; a second instance can't interfere, and a crash frees it. |
| LG4 | MUST | Sign-in codes, tokens, cookies and message text are not written to logs. Routine requests are left out. |
| LG5 | MUST | `npm run doctor` shows the space used by the database, files, backups and logs. Rooms, files and backups are not deleted automatically. |
| LG6 | MUST | A build whose installed packages don't match the lockfile stops with the command to run. Reinstalling is refused when a program is found to use the packages; that check is best effort and says so. |

Not yet verified: a real macOS login item.

## 22. Phone notices

**Status:** Implemented. Design: [Telegram notifications](docs/design/telegram-notifications.md).

| ID | Priority | Requirement |
| -- | -- | -- |
| PN1 | MUST | Off until the lead sets it up at a terminal with a Telegram bot of their own. Contacting Telegram, sending a test and turning notices on each need their own yes. |
| PN2 | MUST | The recipient is the private chat whose own person sent a one-time code, or a typed chat number whose test message the lead confirmed. |
| PN3 | MUST | While the lead is away (10 minutes without activity on the page by default), Konfab tells them that an agent mentioned @lead, a permission request is waiting, or a room has stopped. Never message text, files, links or agent names; room names only if turned on. |
| PN4 | MUST | Limits per room and day, quiet hours, pauses and breaks are respected. What the lead has seen while active, answered or decided, and anything from while notices were off, isn't sent. |
| PN5 | MUST | A notice that may have arrived is not sent again. After a refusal nothing is sent until the lead acts, and the page says why without secrets. |
| PN6 | MUST | Replacing a setup takes effect in one step after everything is confirmed. Cancelling, any failure, or a crash at any point leaves the earlier setup working or sends nothing; a token is only used for its own bot, chat and setup. |
| PN7 | MUST | The token is in the Keychain (or an environment variable), and Konfab gives it to no agent tool, page, export, database, backup or log. Programs running as the lead may still reach it; the documentation says so. |
| PN8 | MUST | One way: after setup Konfab reads nothing from Telegram. Agents have no route to setup or sending. |
| PN9 | MUST | Automated tests use a local stand-in and never contact Telegram. |

Not yet verified: real Telegram delivery, the real Keychain prompt, Linux and Windows.

## 23. Asking agents to rejoin

**Status:** Implemented, marked experimental. Design: [Rejoin agents button](docs/design/rejoin-agents.md).

| ID | Priority | Requirement |
| -- | -- | -- |
| RJ1 | MUST | The lead can ask a Codex agent, or all that can be asked in a room, to come back in the conversation it last joined from. Konfab never does this by itself, and agents have no route to it. |
| RJ2 | MUST | The manual prompts are there in every state. Agents of other apps keep only those, except as in section 24. |
| RJ3 | MUST | The prompt is a fixed text with a one-time request. Nothing anyone wrote is in it. |
| RJ4 | MUST | A request is accepted once, for 10 minutes, from its own agent and conversation, and only while the room, the agent and its session are as they were. All of it is checked and changed in one transaction, or nothing is. |
| RJ5 | MUST | Cancelling, expiry, a pause, a break, archiving, removal, an ordinary join or any other call from that session or conversation makes a request unwanted, also if contact is lost again afterwards. A late prompt changes nothing in the room and never ends a break. |
| RJ6 | MUST | A repeated call answers the same session, never a second one. An agent is shown as back only after its own `wait_for_turn`, also after a crash or a lost answer. |
| RJ7 | MUST | A prompt is sent at most once for each time the lead asks. Only a known refusal, or no process at all, counts as not sent; anything else is shown as unsure and isn't sent again. A second prompt while an earlier one may still be in Codex needs its own yes. |
| RJ8 | MUST | The conversation comes from the app's call metadata, not from a tool argument; a missing or malformed one means none. It is a routing signal, not proof, and the documentation says what it doesn't protect against. |
| RJ9 | MUST | Only a command whose path, owner, folders, signature (for the app's own copy) and version were checked is run, without a shell. Anything else turns the button off, and `npm run doctor` says why. |
| RJ10 | MUST | The request is stored only as a hash, and is in no page, log, activity, export, receipt or agent reply. The conversation is only in the database, its backups and the command's arguments. |
| RJ11 | MUST | Automated tests use a stand-in and never send with the real command. |
| RJ12 | MUST | The button is greyed out only while the agent is there, and says why. For an agent that is away, the card always leads on (section 26). |
| RJ13 | MUST | The room shows that an agent is back at its first wait that counts (not one that only learns of a break or an ended run window) after joining again, however it came back. |

Verified once in the app's own window: conversation open, turn ended normally (2026-11-23). Not yet verified: a conversation stopped with Stop in it, one that is closed or not in front, usage limits, archived conversations, and any system but macOS. The experimental mark stays until the window checks pass.

## 24. Asking Claude agents to rejoin

**Status:** Implemented, off by default, marked experimental. Design: [a background watcher](docs/design/rejoin-claude.md).

| ID | Priority | Requirement |
| -- | -- | -- |
| RC1 | MUST | Off until the lead turns it on (`rejoin.claude_watcher`), and macOS only. While it is off, the answer of a join and the prompts are as before. |
| RC2 | MUST | The agent is asked, by the lead's prompt in advance, to start one fixed command. Konfab starts nothing in the app and changes no setting of it. |
| RC3 | MUST | The watcher prints nothing until it ends, reads only its ticket's file, and calls only Konfab on this computer. It ends with the app. |
| RC4 | MUST | Its ticket is good for two routes and nothing else. It is in a private file until the first accepted call, and then only in the watcher's memory; Konfab keeps its hash. It is in no conversation, process list, page, log, export or backup. |
| RC5 | MUST | A ticket is bound at the first call to a process that Konfab itself finds to be this user's watcher with that ticket. Whatever can't be established is refused. |
| RC6 | MUST | A request is told to a watcher at most once, in one transaction with all checks of section 23, and only on an open call. "Sent" means that the watcher wrote the whole line and Konfab received its confirmation; anything else is unsure and isn't sent again. Only a wait by the agent counts as back. |
| RC7 | MUST | At most 3 registered watchers for a conversation and 6 for an app. A place is freed only by proof that the process is gone; what isn't clear keeps it, however long. Konfab sends no signal to any process. |
| RC8 | MUST | A watcher that has done its work wakes nobody. One is told to end only while its own agent is waiting, at most twice a day for a conversation, and not after a clean-up that seems to have woken it. |
| RC9 | MUST | Stop isn't overruled: the prompt says not to come back with a request after it, and how to answer that, which only tells the lead. The page says to paste the rejoin prompt. |
| RC10 | MUST | The model's part is an instruction, not a boundary; the documentation says so. The manual prompts work in every state. |

Verified by hand with the watcher in the app's own window, once (2026-11-24): the agent had ended its own turn, and the lead's click brought it back. Verified with a plain waiting command (2026-11-23): the app started a conversation again whose turn the agent had ended, after 2 and after 32 minutes; after Stop it started it as well, and the agent stayed out. Not yet verified: an app that was closed, compaction in between, usage limits, sleep, what a resting watcher costs, and whether the app asks for each command.

## 25. Stopping one agent

**Status:** Implemented. Design: [Stop button for one agent](docs/design/stop-agent.md).

| ID | Priority | Requirement |
| -- | -- | -- |
| ST1 | MUST | On an agent's own card the lead can ask that agent to leave the room's loop: at once when it waits, after a running turn, or at its next wait when it reported work outside a turn. Agents have no route to it. |
| ST2 | MUST | Nothing that runs in the app is interrupted, and the page says so. The name doesn't promise more: "Stop agent", "Stop after turn", "Stop after this work". |
| ST3 | MUST | The end of a turn and the stop are one transaction, and the answer of the post, pass or wait says "stop", also when it is repeated after a lost answer. |
| ST4 | MUST | Asked, answered and received by its connector are different states. "Stopped" is only shown for received. No text says that the model read it, that its app has stopped or that it uses no allowance. |
| ST5 | MUST | A session that is asked to stop gets no further turn and holds nobody up. Nothing queued is lost, doubled or given to somebody else. |
| ST6 | MUST | Until it has stopped, the lead can keep it. Rejoin isn't offered while a stop is asked. |
| ST7 | MUST | Later calls of a stopped session are refused, change nothing and count as no contact; the card says that it called. |
| ST8 | MUST | The rest of the run window is kept once, however often it is stopped and joins again. |
| ST9 | MUST | A join while a stop is asked ends that stop, and the card, the room and the activity say so without saying who wanted it. |
| ST10 | MUST | While a stop is asked, locks stay until their own end, also when nothing is heard. |

Verified once in each app's own window (2026-11-24): a waiting agent was stopped, its connector confirmed it, it made no further call, and Rejoin brought it back without a prompt. Not yet verified there: stopping after a turn, Keep in room, reported work.

## 26. Stop and Rejoin in every situation

**Status:** First phase implemented. Design: [Stop and Rejoin in every situation](docs/design/robust-stop-rejoin.md).

| ID | Priority | Requirement |
| -- | -- | -- |
| SR1 | MUST | For an agent that is away, the card always has one main next step: rejoin, resume and rejoin, or open its app and copy the prompt. What to do next is said at once. Nothing leads to a paste while the agent is there. |
| SR2 | MUST | A control that opens an app or replaces the clipboard says so in its name; one that does both says both. Opening and copying have separate results, and neither stops the other. No text says that an app or a conversation has opened. |
| SR3 | MUST | An app is opened only by the lead's click, with a fixed command and path, and `rejoin.open_apps: false` turns it off. Opening sends nothing to an agent and makes no session. |
| SR4 | MUST | After such a click the page says whether the agent has come back meanwhile. While a request is open, it says what a paste would replace. |
| SR5 | MUST | Resuming a room, or ending its break, together with a rejoin is asked first. The question names the whole room, the agents with queued turns, and who is asked. Only what was shown is changed; if the second step fails, the first stays and the page says both. An archived room is changed by none of it. |
| SR6 | MUST | An agent can answer a request with "declined", through the same tool and argument, so that an older server or connector can't take it for a wish to come back. It closes its own open request and changes nothing else. |
| SR7 | MUST | Stop agents, in the room's header, asks each agent that is there by the rules of section 25, in one transaction each. It shows first what each is told; a failure of one leaves the others asked. An agent that joins afterwards isn't stopped. Keep all undoes those that haven't ended. |
| SR8 | MUST | Counts and lists of stopped agents say only what is known of each. No text says "done", "safe to close", or that an app has stopped. |

Not yet verified by hand: opening each app from the page, the agent's own answer after its app's Stop, and the evening and the morning as a whole. Opening one exact conversation is a later phase.

## 27. Settings in the page and on the command line

**Status:** First phase implemented (Rejoin, the options of phone notices, and the command line for all settings in `config.yaml`). Design: [Settings](docs/design/settings.md). Everything the setup commands do, and all settings in the page, come with later phases.

| ID | Priority | Requirement |
| -- | -- | -- |
| SE1 | MUST | The page and the command line change the same stores by the same code and rules. Each setting is described once; a test holds the schema, the list and the user guide together. |
| SE2 | MUST | Both say whether a change is in use: at once, from the next join, after a restart, not confirmed, or not running. A saved value that isn't in use is shown beside the one that is. |
| SE3 | MUST | A change writes only the named keys. The rest of the file, comments and unknown keys stay. What can't be changed safely is refused, and nothing is written. |
| SE4 | MUST | Konfab's own writers never overwrite each other or a file other than the one shown. What an editor can lose is documented. Links, other owners and folders that others can change are refused. The five versions before are kept, private. |
| SE5 | MUST | A running server takes on Rejoin and phone-notice settings without a restart. With a file it can't use, it keeps the earlier values and says why. |
| SE6 | MUST | Turning Rejoin or the watchers off closes open requests and tells nothing more to a watcher; what was told before is documented. |
| SE7 | MUST | Nothing runs another Codex command before the lead's yes to exactly that file, also after it was changed by hand or has changed. One that was set before counts as agreed once. Its identity is looked at again before each run. |
| SE8 | MUST | The routes need the lead's session and this page's own origin, and refuse an agent's token and unknown or not-yet-editable settings. |
| SE9 | MUST | Existing files work unchanged, `npm run setup` does what it did, and going back to an earlier version works. |
