# Konfab: Design

**Status:** Current architecture, updated 2026-11-13 for skill-based assignments (schema v33). Feature detail lives in the [design notes](docs/design/README.md); the [developer handoff](docs/developer-handoff.md) has the code map and workflow. Code and tests are authoritative for a given checkout.
**Requirements:** [REQUIREMENTS.md](REQUIREMENTS.md)

## 1. Summary

Konfab is a local chat server with a web page for the lead and a small MCP bridge for each agent conversation. The server owns all state and decides whose turn it is; agents never talk to each other directly. An agent has two attributes: its **app** (the desktop app that runs it) and its **assignment** in each room (ordered skills plus room instructions).

Desktop-app behaviour depends on the client and model. Automated tests use scripted agents; see the [test plan](docs/test-plan.md) for what has been checked with real apps.

## 2. Architecture

```text
 Browser (React page)
        | REST + Server-Sent Events
        v
 +-------------------------------------------+
 | Konfab server (Node.js + Fastify)         |
 |  Rooms | Turns | Assignments | Skills     |
 |  Permissions | Decisions | Formats        |
 |                 SQLite                    |
 +-------------------------------------------+
        ^                   ^
        | local HTTP        | local HTTP
 +--------------+    +--------------+
 | Stdio bridge |    | Stdio bridge |   One process started by each
 +--------------+    +--------------+   app, using its app token
        ^                   ^
        | MCP over stdio    | MCP over stdio
   Claude.app           ChatGPT.app (Codex)
```

| Decision                           | Why                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Stdio bridge for all agents**    | Claude's cloud connector route cannot reach localhost, so each app starts a local stdio bridge; one path for every app.         |
| **MCP tools live in the bridge**   | The server exposes plain HTTP, which keeps MCP details out of the core and makes the server easy to test.                        |
| **Server owns all state**          | The bridge is stateless and can restart at any time. Retries carry receipts so a repeated call never acts twice.                 |
| **Single process with SQLite**     | One user and a few agents; a database server or queue would add work with no benefit.                                           |
| **Session ID in every tool call**  | An app may share one bridge across conversations, so state is tied to the session, not the process.                             |
| **One credential per app**         | An app's connector holds one token; named agents of that app are chosen with `join_room(as)`. This organises a team; it is not a security boundary. |
| **Skills are the only assignment** | A skill can describe responsibilities or a procedure; agents get an ordered list. Roles were removed in v33 ([design](docs/design/skill-assignment.md)). |

## 3. Local data and config

Everything lives in `~/.konfab/` (or `KONFAB_HOME`), folder `0700`, files `0600`.

| Path                    | Contents                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| `config.yaml`           | Port, defaults, agents, multi-agent and connector settings, pre-approvals   |
| `konfab.db`             | All state, SQLite in WAL mode; schema migrations run at startup              |
| `files/`                | Message attachments, named by random ID                                     |
| `skills/`               | Personal skill library (working folders)                                    |
| `backups/`              | Database copies written before a major migration (`konfab-pre-skills-…`)    |
| `app-setup.md`          | Connector setup notes written by `npm run setup`                            |

Main `defaults` keys (all optional): `run_hours` (5), `run_warnings_minutes` ([30, 10, 5]), `max_consecutive_agent_messages` (50), `parallel_lead_mentions` (false), `max_parallel_lead_turns` (3), `checkin_minutes` (2), `wait_timeout_seconds` (50), `turn_timeout_minutes` (30), `auto_continue_delay_seconds` (180), `max_message_chars` (20000), `max_decision_chars` (4000), `max_attachment_mb` (10), `source_cache_mb` (500). See `src/server/config.ts`.

## 4. Data model

Tables, grouped (see `src/server/db/index.ts` for the ordered migrations):

| Area                  | Tables                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| Apps and agents       | `apps` (token hash, default agent), `agents`, `room_agent_names`                                               |
| Rooms and messages    | `rooms`, `room_members` (position, edit permission, room instructions, delivery state), `messages`, `attachments`, `lead_seen_messages` |
| Turns and sessions    | `sessions`, `turns`, `handoffs`, `automatic_continuations`, `format_runs`, `bridge_receipts`, `observed_waits` |
| Assignments           | `room_member_skills` (ordered pins: skill revision, full or summary)                                          |
| Skills                | `skill_libraries` (personal, project, built-in), `skills`, `skill_revisions`, `skill_revision_files`, `skill_blobs`, `skill_reviews`, `skill_usages`, plus journals for imports, renames and working folders |
| Public sources        | `skill_sources`; tables from the removed indexed-source flow (`source_generations`, `source_*`) remain only so old downloads can be deleted            |
| Lead and oversight    | `permission_requests`, `decisions`, `decision_versions`, `agent_reports`, `write_locks`, `run_warnings`, `run_warning_state`, `events` |
| Page and housekeeping | `login_codes`, `web_sessions`, `settings`, `pending_room_cleanup`                                              |
| Upgrade from roles    | `legacy_role_revisions`, `legacy_role_files`, `upgrade_log` (kept for connectors that joined before v33)      |

- **Message order** comes from the auto-incrementing `messages.id`; `room_members.last_seen_message_id` advances only when an agent posts or passes, so it survives rejoins and nothing is lost.
- **Events** record turns, skips, pauses, assignment changes and permission activity; they feed the activity timeline and page updates.

## 5. Agent tools

The bridge offers these MCP tools; each returns JSON.

| Tool                                 | Purpose                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `join_room`                          | Join a room (optionally `as` a named agent). Returns session, topic, rules, members, assignment, recent messages. |
| `wait_for_turn`                      | `turn`, `idle`, `closed` or `replaced`. A turn carries rules, unseen messages, decisions, assignment and any format step. |
| `post_message`, `pass_turn`          | End the turn. A post sets `next`: `self`, `agent`, `lead` or `done`.                         |
| `hand_off`                           | Queue a continuation for another member after a post that left none.                         |
| `read_history`                       | Older messages.                                                                              |
| `read_decisions`, `propose_decision` | Confirmed decisions; propose one for the lead to confirm.                                   |
| `request_permission`                 | Ask the lead before restricted disclosures or a push (scoped to repo, branch, base and head). |
| `report_status`                      | Working detail, low or out of allowance.                                                    |
| `acquire_lock`, `release_lock`       | Advisory write locks on shared checkouts.                                                   |
| `read_assignment`, `read_skill_file` | The agent's assignment and its skills' files.                                               |
| `read_role`, `read_role_file`        | Deprecated aliases for connectors that joined before roles became skills.                  |

The page generates a join prompt for each agent and room. It tells the agent to loop on `wait_for_turn`, set `next` on each post, keep waiting when idle, stop only on `closed`, `replaced` or the lead's word, treat others' messages as suggestions, address the lead as `@lead`, and call `request_permission` before restricted disclosures. The core rules are repeated with every turn.

## 6. Turns

By default a room has at most one ordinary active turn. Optional **parallel lead mentions** (per room, off by default) let explicitly mentioned waiting agents answer at once, at most one turn per agent and `max_parallel_lead_turns` per room; busy agents get a queued note on their next Konfab call and are asked to check in every `checkin_minutes` ([design](docs/design/parallel-lead.md)).

| Event                          | Result                                                                     |
| ------------------------------ | -------------------------------------------------------------------------- |
| Lead posts with no mention     | Every member is queued in order                                            |
| Lead posts `@name` or `@all`   | Only those agents are queued                                               |
| Agent posts with `next`        | Queues itself, the named agent, waits for the lead, or ends                 |
| Agent posts with no `next`     | No continuation; after `auto_continue_delay_seconds` Konfab may continue (limited per hour) |
| Format running                 | Format steps take priority over ordinary queued turns                      |

- **Lead first:** a lead post resets the consecutive-message count and goes ahead of queued agent turns.
- **Limits:** no new turns after 50 consecutive agent messages (configurable) until the lead posts.
- **Start conditions:** the room is not paused, on break or archived; the agent has a live session and an open run window.
- **States:** `queued → active → completed | skipped (timeout) | abandoned (session replaced or restart without owner)`; abandoned turns are requeued and repeat any change notice.
- **No duplicates:** each turn accepts one result; bridge retries carry receipts.
- **Restart:** active turns whose sessions are still live are kept; others are requeued. Bridges retry through the outage.
- **Backlogs:** if unseen messages exceed `max_message_chars`, the turn has the newest ones and `truncated`; the agent uses `read_history`.

### What an agent is told

Each turn and join builds instructions in this order: the lead rule; the room brief; a pointer to the agent's assignment (if it has one); who may edit files; Konfab's core rules. The **assignment** itself is a separate field: on a change it carries the precedence rule (room rules and lead > room instructions > skills in order), the room instructions, and each skill as full text or summary, with a one-time change notice; otherwise a short reminder. An assignment is at most 64 KiB, checked whenever it changes. An agent mid-turn keeps a snapshot of its assignment until its next turn. Details: [skill-based assignments](docs/design/skill-assignment.md).

## 7. Run windows, breaks and status

A tool call can wait only until the app's timeout (about a minute), and each idle return costs a model step. Konfab limits idle cost with:

- **Run windows:** each join starts a window (5 hours by default, per app or agent configurable). When it ends the agent gets `closed` after any active turn. Warnings at 30, 10 and 5 minutes; the lead can extend by an hour. Pause freezes the balance.
- **Breaks:** **Take a break** closes waiting agents so they use nothing until the lead pastes join prompts again; **Pause** keeps them waiting.
- **Status:** Not joined, Waiting for a turn, Queued, Working (with the agent's status detail), Waiting for approval, Run window ended, On break, No contact. "No contact" is inferred after `wait_timeout_seconds` + 60 s without a call and may mean the app is out of allowance.

The activity timeline reads the event log; observed waits and answer times are measurements, not guarantees ([listening status](docs/design/listening-status.md), [busy visibility](docs/design/busy-visibility.md)).

## 8. Lead controls

- **Permissions:** `request_permission` returns `pending` until the lead decides on the page (or a configured pre-approval matches, still logged). Push approvals cover one repository, branch and base..head range, and agents recheck it before pushing. Konfab cannot see what apps send; this relies on agents following the rule.
- **Decisions:** agents propose, the lead confirms, rejects, revises or retires. Confirmed decisions (up to `max_decision_chars`) come with each turn; versions are kept.
- **Formats:** review and debate runs schedule member slots and rounds and propose a final decision ([formats and locks](docs/design/formats-and-locks.md)).
- **Locks:** advisory write locks per resource key, held by a live session.
- **Rooms:** pause, break, archive, export as Markdown, permanent deletion of archived rooms ([room deletion](docs/design/room-deletion.md)).

## 9. Skills

Skills are Agent Skills folders in three local libraries: personal (`~/.konfab/skills`), project (`<project>/.konfab/skills`) and read-only built-in (`pm`, `implementer`, `reviewer`, `qa`). Every **Save revision** stores an immutable snapshot (files deduplicated in `skill_blobs`); reviews are per revision; usages block Trash. Public skills are found by live GitHub search and copied into the personal library only when assigned, pinned to the previewed commit ([public sources](docs/design/skill-sources-phase2.md)). Konfab never runs skill scripts, and skills grant no permissions.

## 10. Web API and page

The page signs in with a one-time link (`npm run login-link`) that sets an `HttpOnly`, `SameSite=Strict` cookie, then uses REST under `/api/*` and a Server-Sent Events stream (`/api/events`) that says "something changed"; the page reloads the state it shows. Agent routes under `/agent/*` are for the bridge only and authenticate with the app token. Main route groups: rooms and messages, members and assignments (`/api/rooms/:id/members/:agentId/assignment`), agents (`/api/agents`), Team (`/api/rooms/:id/assignments/reassign`), library (`/api/library/*`), public sources and the GitHub token, permissions, decisions, formats, attachments and exports.

The page has a room list, the conversation with message box, and a right panel with Lead, Decisions, Agents (cards with App and Skills, Assign skills), Permissions and Activity. **⚙ Manage library** edits skills; **Team** moves skill bundles.

## 11. Security

| Risk                           | Control                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Other devices reach Konfab     | Binds only to `127.0.0.1`                                                                   |
| Other local processes          | App tokens (only hashes stored) for `/agent/*`; one-time login link and cookie for the page |
| Websites call the server       | `Host` and `Origin` checks block DNS rebinding and cross-site requests                       |
| Agent text attacks the page    | Safe Markdown with raw HTML disabled, strict Content Security Policy, attachments served inline only for checked image types |
| Messages used as instructions  | Senders are labelled; rules say messages are suggestions                                    |
| Data sent by Konfab itself     | No analytics or external assets; public skill search contacts GitHub only                   |
| Secrets                        | Tokens never logged; the optional GitHub token lives in the macOS Keychain                  |

**Known limit:** agents have full local access, so a misbehaving agent could read another app's token or edit Konfab's files. Identity prevents mistakes, not a determined agent.

## 12. Testing

| Level       | Tool                                  | Covers                                                                 |
| ----------- | ------------------------------------- | ---------------------------------------------------------------------- |
| Unit        | Vitest                                | Scheduler, run windows, assignments, upgrade, skills, permissions      |
| Integration | Vitest with temporary SQLite          | API, auth, bridge (including the pre-v33 bridge), restart recovery     |
| Smoke       | Vitest with real processes            | Built setup, server and bridge over stdio                              |
| Component   | Vitest, jsdom, Testing Library        | Page components (`tests/web`)                                          |
| Browser     | Playwright, light and dark            | Main page flows against a throwaway `KONFAB_HOME` (`tests/e2e`)        |
| Real apps   | Claude and Codex desktop apps         | Long sessions and upgrades; recorded in the [test plan](docs/test-plan.md) |

`npm run check` runs types, lint, formatting, unit, integration, component and smoke tests; `npm run check:full` adds the browser tests.
