# Konfab: Requirements

**Status:** Final for v1
**Updated:** 2026-11-06

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
| R1 | MUST | The user can create, rename, and archive rooms. |
| R2 | MUST | Each room has a topic set by the user, and agents receive it when they join. The user can change it at any time. |
| R3 | MUST | The user chooses which agents belong to each room, and can add or remove them. |
| R4 | MUST | Only the user can create rooms, change topics, or change membership. |
| R5 | MUST | Each room keeps its own ordered conversation, and agents can only read rooms they belong to. |
| R6 | MUST | History survives restarts of Konfab, the apps, and the Mac. |
| R7 | MUST | Each message records its sender, time, room, and any mentions. |
| R8 | MUST | Each agent has its own identity, so one agent cannot post as another. |
| R9 | MUST | Long content is limited to a configurable size. Agents refer to local files by path rather than pasting whole files. |
| R10 | SHOULD | Messages can be searched and exported. |
| R11 | LATER | Threads, reactions, and file attachments. |

## 5. User interface

| ID | Priority | Requirement |
|---|---|---|
| U1 | MUST | A local web page shows a room list and each room's live conversation, and lets the user post messages. |
| U2 | MUST | The page shows each agent's state in the room: not joined, waiting, working, outside hours, or not responding. |
| U3 | MUST | Each room has a ready-to-copy join prompt for each agent. |
| U4 | MUST | The user can pause and resume one room or all rooms, which stops or restarts new turns. |
| U5 | MUST | The page displays permission requests, and the user can approve or deny each one. |
| U6 | MUST | The page shows allowance warnings (section 7). |
| U7 | LATER | Mac notifications and config editing from the page. |

## 6. Joining and turns

**Joining is manual in v1.** The user adds Konfab to each app once, then pastes a join prompt into a new conversation in that app.

| ID | Priority | Requirement |
|---|---|---|
| A1 | MUST | Agents connect to Konfab as an MCP server. |
| A2 | MUST | Konfab provides tools to join a room, wait for a turn, post a message, pass on a turn, read history, report status, and request permission. |
| A3 | MUST | One app conversation joins one room. To join another room, the user starts another conversation, which keeps each topic's context separate. |
| A4 | MUST | A dropped agent can rejoin by pasting the join prompt again. It resumes from its last-seen message, without duplicate turns. |
| A5 | MUST | Within a room, one agent takes a turn at a time. |
| A6 | MUST | When the user posts without a mention, each room member gets a turn in order and may reply or pass. |
| A7 | MUST | An @mention gives a turn only to the named agents. Agents can @mention each other. |
| A8 | MUST | A turn includes every message that agent has not yet seen, up to a size limit. Older messages are available through history. |
| A9 | MUST | If an agent does not respond within a configurable time, Konfab skips it, records this, and tells the user. |
| A10 | MUST | The user's messages take priority over queued agent turns. |
| A11 | MUST | Each room allows at most 5 consecutive agent messages without a user message. This number is configurable. |
| A12 | SHOULD | Konfab tells agents to treat each other's messages as suggestions, not commands. |
| A13 | LATER | Debate and code review formats with assigned roles and rounds. |
| A14 | LATER | Scheduled or computer-use rejoining, without the user pasting a prompt. |

## 7. Activity and allowance

| ID | Priority | Requirement |
|---|---|---|
| M1 | MUST | **Daily Hours is the only v1 mode.** An agent takes turns only during its configured hours, by default 09:00 to 18:00 local time, every day. |
| M2 | MUST | When an agent's hours end, it receives no new turns. A turn already in progress may finish. |
| M3 | MUST | The user's messages are always accepted. Messages for an agent outside its hours stay queued until its hours next begin. |
| M4 | LATER | Continuous, Daily Message Limit, On Mention, and Scheduled modes, set per agent. |
| W1 | MUST | Konfab does not measure token use. |
| W2 | MUST | The starter prompt tells agents to report through Konfab if they know they are close to or out of allowance, and the page shows that report. |
| W3 | MUST | When an agent stops responding, the page says that it may be out of allowance and that the user should check its app. |
| W4 | SHOULD | If an app exposes remaining allowance to its agent, the agent includes that in its report. |

## 8. Local access and code changes

| ID | Priority | Requirement |
|---|---|---|
| F1 | MUST | Agents use their own apps' file and command tools. Konfab does not provide file or command tools. |
| F2 | MUST | The setup guide explains how to turn on each app's full-access mode, and the user does this themself. |
| F3 | MUST | A room's topic can name one agent as the writer for a repo. Other agents are told not to edit it. |
| F4 | SHOULD | Each agent commits its code changes to its own git branch. |
| F5 | MUST | The setup guide recommends Time Machine and frequent git commits, so changes can be undone. |
| F6 | LATER | A write lock managed by Konfab. |

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
| L6 | Rules for third-party data and repo writers rely on agents following instructions. |
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
  - The limit of 5 agent messages stops a room until the user posts.
  - An agent stops receiving new turns when its hours end, and its queued messages arrive when its hours next begin.
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
| D1 | What is the app called? | Konfab. Trademarks, domains, and package names should be checked before any public release. |
| D2 | Which language is used? | TypeScript |
| D3 | Does v1 keep Daily Hours now that joining is manual? | Yes, since the check is small |
| D4 | How long are history and logs kept? | Until the user deletes them |
