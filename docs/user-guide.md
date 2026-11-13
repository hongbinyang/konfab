# Konfab user guide

How to set up Konfab, run rooms with your AI apps day to day, and look after it. For a quick overview, start with the [README](../README.md). Keep your backups and git commits current: agents can change files on your Mac.

**Contents**

- Setting up: [1. Start Konfab](#1-start-konfab) · [2. Connect your apps](#2-connect-your-apps) · [3. Open a room](#3-open-a-room)
- Everyday use: [4. Talking in a room](#4-talking-in-a-room) · [5. Roles and skills](#5-roles-and-skills) · [6. Decisions and permissions](#6-decisions-and-permissions) · [7. Save allowance](#7-save-allowance) · [8. Bring an agent back](#8-bring-an-agent-back)
- Working as a team: [9. Several agents per app](#9-several-agents-per-app) · [10. Parallel answers to your mentions](#10-parallel-answers-to-your-mentions-experimental) · [11. Review and debate formats](#11-review-and-debate-formats) · [12. Write locks](#12-write-locks)
- Looking after Konfab: [13. Rooms: archive, export, delete](#13-rooms-archive-export-delete) · [14. Restart or update](#14-restart-or-update) · [15. GitHub token](#15-github-token-optional) · [16. Stop and uninstall](#16-stop-and-uninstall)
- Reference: [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Checks](#checks)

## 1. Start Konfab

Follow the setup steps in the [README](../README.md), then run `npm start` and open the sign-in link it prints. Each link works once and expires after 10 minutes; run `npm run login-link` for a new one. To start Konfab automatically at login, run `npm run login-item -- install` (`uninstall` to turn it off).

Keep your Mac awake and the apps open while agents are in a room.

## 2. Connect your apps

`npm run setup` connects **both apps the same way**: it adds a `konfab` connector to each app's user-level settings, so Konfab is available in every folder you open. You don't need a special project folder.

| App    | Where setup adds the connector                                      |
| ------ | ------------------------------------------------------------------- |
| Codex  | `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`)               |
| Claude | `~/.claude.json`, user scope (or `$CLAUDE_CONFIG_DIR/.claude.json`) |

1. Run `npm run setup`. It changes only the `konfab` entry, keeps everything else in those files, and backs up any file it changes. Running it again changes nothing.
2. Restart Codex, and restart the Konfab connector in Claude's Code tab (or quit and reopen the app).
3. Open either app in any folder and paste a join prompt (see [Open a room](#3-open-a-room)). Claude may ask you to approve the connector the first time. Claude's Code tab always asks for a working folder; any folder works, and an empty one such as `~/konfab-workspace` is a good choice.

Setup's backups contain your agent tokens, so keep them private and delete them once you no longer need them.

**Options**

- `npm run setup -- --manual`, or `connectors: { install: manual }` in `~/.konfab/config.yaml`: don't touch the apps' files; write the connector entries to `~/.konfab/app-setup.md` for you to add yourself.
- `npm run setup -- --rotate`: issue new tokens and update both apps. Agents connected with the old tokens stop working until their connector reloads.
- `npm run setup -- --github-token`: store an optional GitHub token (see [section 15](#15-github-token-optional)).

**Moving from a project `.mcp.json`.** Earlier versions put Claude's connector in a project folder's `.mcp.json`. To switch: run `npm run setup` (it reuses your tokens), reload the connector in Claude, check that an agent can join from a **different** folder, then remove the old entry with `npm run setup -- --migrate /path/to/old/project` (one folder per command; it backs up the file and leaves other connectors alone). If setup can't find a token to reuse, it says so; restore the old configuration or run `--rotate`.

**Full access.** Each app has its own full-access setting. It lets agents work without approval prompts, and also lets them change anything on your Mac, so try it on a throwaway repo first. Konfab can't change an app's permissions.

## 3. Open a room

1. On the Konfab page, create a room with a name and topic, and choose its agents.
2. Select **Edit** on the room to add a **Brief for agents** and, for a code project, its **Project folder** (an absolute path; it enables project skills and a suggested write-lock key).
3. Give each agent a role with **Change role** on its card (see [section 5](#5-roles-and-skills)). Tick **Can edit files and repos** only for agents that should change code.
4. Select **Copy join prompt** for each agent and paste it into a new conversation in that app. Use one conversation per room.
5. Check that each agent shows **Waiting for a turn**, then post a message.

You are always the lead: agents are told to follow your instructions and decisions and to address you as `@lead`. Brief and role changes apply from each agent's next turn. These are instructions, so an agent can still ignore them.

**Starting a fresh room for an existing project.** Long rooms slow agents down. To continue in a new room, put a short handoff file in the project (this repo uses [docs/handoff.md](handoff.md)), create the new room with the same project folder, point its brief at the handoff file, and paste fresh join prompts. Room messages and decisions don't carry over; anything in the repo does.

## 4. Talking in a room

- **Who answers:** a post with no mention gives each agent a turn in order. Use `@name` or `@all` to choose. Agents mention you with `@lead`; such a message is highlighted and waits for you.
- **Handoffs:** agents say who goes next when they post (themselves, another agent, you, or done). Below the message box, **Taking a turn** and **Next** show who has the next step. **No continuation queued** means nobody was asked to continue; use **Ask … to continue** if work should go on.
- **Automatic continuation:** if an older connector posts without saying who is next, Konfab continues after three minutes (shown with a countdown and **Cancel**). At most three automatic recoveries per hour per room, then the room shows **Stuck · needs you**. You can turn this off per room.
- **Limits:** a room waits for you after 50 agent messages in a row.
- **Status:** an agent doing longer work shows **Working · N min: detail** on its card. A warning after `turn_timeout_minutes` means no progress update has arrived; it doesn't prove the agent stopped.
- **Unread:** new agent messages have a soft tint and a **New messages** divider. Room badges and the tab title show counts (**@** for mentions). **↓ N unread** jumps to the next unread reply; **Mark all read** (or Esc) clears the room.
- **Search and export:** search a room's messages, or **Export** it as a Markdown file.
- **Attachments and emoji:** use the 📎 and 😊 buttons next to **Send**.
- **Right panel:** collapsible sections for Lead, Decisions, Agents, Permissions and Activity; your layout is remembered.
- After a server restart, a notice offers to reload the page.

## 5. Roles and skills

A **role** is an ongoing responsibility (for example product manager or reviewer). A **skill** is a reusable workflow (a folder with a `SKILL.md`, in the open Agent Skills format). Roles and skills are instructions only: they never grant permissions, and Konfab never runs their scripts.

**Give an agent a role.** On the agent's card, select **Change role**. One search covers:

| Filter        | What it shows                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------- |
| **My roles**  | Built-in roles and the roles you saved (`~/.konfab/roles`)                                      |
| **My skills** | Skills you saved, usable in any room (`~/.konfab/skills`)                                       |
| **Project**   | Skills stored in the room's project (`<project folder>/.konfab/skills`); needs a project folder |
| **Public**    | Skills from GitHub sources enabled in **⚙ Manage library → Public**                             |

Combine filters freely; **All** clears them. A hint under the filters shows where each one comes from. Select a result to preview its instructions, files, licence and source, then choose **Review & assign** (approves and pins exactly that version) or **Customize** (edit your own copy, then **Save and assign**). Public skills are searched live; nothing is saved until you assign or customize, and then only that skill, pinned to the version you previewed. If its source changes later, the role shows **Update available** (or **Removed from source**); nothing changes until you choose.

**Rearrange the team.** Select **Roles** in the room header. Drag a role onto another member (or use **Swap with**) to swap; repeat to rotate. You can also give someone a saved role or remove a role. Review the before-and-after list, then **Apply**. Room notes move with the role; **Can edit files and repos** stays with each agent. Agents get their new role and a short notice on their next turn, in the same conversation; an agent mid-turn finishes under its old role first. A role doesn't change an app's folder or permission settings.

**Manage the library.** **⚙ Manage library** (sidebar) is for editing and organising: create and edit skills, save revisions, review them, restore history, rename, duplicate, Trash; build roles that pin reviewed skill revisions; manage public sources, the optional GitHub token and old downloaded indexes. For the full walkthrough, see [Skills and roles](skills-and-roles.md).

## 6. Decisions and permissions

**Decisions** record what the room agreed. Agents can propose a decision; you **Confirm** or **Reject** it in the **Decisions** panel, or add one yourself with **+ Add decision**. Each card shows its number (for example **#5**), and "#5" in text links to that card. Confirmed decisions are shown to agents on every turn; agents propose a change rather than act against one. Decisions belong to their room.

**Permissions.** Agents ask through Konfab before sending data to outside services or pushing code, and the request appears on the page for you to answer. A push approval covers one repository, branch and commit range. To pre-approve pushes to a repository, add it to the config and restart Konfab:

```yaml
pre_approvals:
  - recipient: github.com/OWNER/REPO
    data: code_push
```

Pre-approved actions are still logged. This relies on agents following instructions, because Konfab can't see or block what the apps send. Your apps can also show their own prompts (file access, running commands); if an agent seems stuck and Konfab shows no request, check its app.

## 7. Save allowance

Waiting agents use your subscription allowance even when idle, so join agents only to rooms you're using.

|                                 | Pause                   | Take a break                  |
| ------------------------------- | ----------------------- | ----------------------------- |
| New turns                       | Stopped                 | Stopped                       |
| Agents use allowance while idle | Yes                     | No, they stop                 |
| How agents come back            | Automatically on Resume | You tell each agent to rejoin |

**Pause all rooms** and **Break for all rooms** in the sidebar act on every room. During a break, a turn in progress can finish; messages you post wait for the agents. **Wait calls** under **Activity** should stop increasing; if not, press stop in the app.

**Run window.** Each agent gets 5 hours of usable time, shown as a countdown on its card, with warnings at 30, 10 and 5 minutes and an **Extend 1 hour** action. Pause freezes it; a break saves the balance for the next rejoin. Unpaused server downtime still counts.

Longer waits also use less allowance: raise `defaults.wait_timeout_seconds` (see [Configuration](#configuration)). If an app cuts waits short, raise `tool_timeout_sec` in the Codex entry, or set `MCP_TOOL_TIMEOUT` (milliseconds) for Claude.

## 8. Bring an agent back

You don't need a new conversation. In the agent's existing conversation, say:

| When                                                        | Say                                                |
| ----------------------------------------------------------- | -------------------------------------------------- |
| The session ended (run window over, a break, room archived) | `Rejoin Konfab room <room> and continue the loop.` |
| The agent stopped with an error                             | `Continue the Konfab loop in room <room>.`         |
| The card says **No contact** or **Working · no update**     | `Rejoin Konfab room <room> and continue the loop.` |

Konfab shows **No contact since 5:00 PM** when a waiting agent hasn't checked in for 90 seconds (the same rule Konfab uses to decide whose turn is next), or **Working · no update since …** when a busy agent misses two check-ins. During a long turn the card may say **Working · no contact since …**; a long command may still be running, so check the app before rejoining. Konfab can't tell why a conversation stopped (the app closed, it hit a limit, or the agent ended its reply), so it shows the last contact time and a **Copy rejoin prompt** button. If you @mention an agent in that state, or one that hasn't joined, a note under the message box says so straight away.

Rejoining after a break restores the saved balance once; other rejoins start a fresh window. Paste the join prompt into a new conversation only if the old one has become very long or slow; the old one then stops by itself.

## 9. Several agents per app

Every agent has two attributes: its **app** (the desktop app that runs it, such as Claude or Codex) and its **role** in each room. You can have several agents on the same app, for example `claude` and `reviewer`.

To add one, choose **+ Add agent** at the top of the room's **Agents** panel. Enter a display name (the agent ID is filled in for you and is what you @mention), pick the **App**, and keep **Add to this room** ticked to pick a **Role in this room** straight away. Konfab shows that exact role revision (its instructions and pinned skills); tick **I reviewed this role** to assign it. Roles with unreviewed skills can't be assigned until you review them in **Manage library**. Then use the new card's **Copy join prompt** in a separate conversation in that app. Each card shows **App:** and **Role:** chips; roles stay per room, so change one later with **Change role** or swap them with **Roles**.

Each agent has its own session, role and turns. Agents of one app share that app's credential and account allowance: conversations in that app are trusted to act as any of its agents, so this is for organising a team, not a security boundary. The default limit is four agents per app (`multi_agent.max_per_app`). You can rename an agent's display name; to remove one, end its sessions first (its history stays).

## 10. Parallel answers to your mentions (experimental)

By default a room gives one agent a turn at a time, so a mention waits for the current turn to end. In room **Edit**, tick **Answer my @mentions in parallel (experimental)** to change that:

- A **waiting** agent you @mention gets a turn **immediately**, even while another agent is working. Its reply appears in the room as usual.
- A **busy** agent you mention can't be interrupted. It sees a note about your mention the next time it checks in, can acknowledge it in its status line without stopping, and answers in a queued turn afterwards. Its card shows **Mention queued · since HH:MM**.
- **Check-in interval while working** (room **Edit**: Default (2 min), 1, 2, 5 or 10 minutes) sets how often busy agents are asked to check in. Shorter means faster answers but more allowance. Check-ins are cooperative: an agent can't check in while a long command is running.
- Posts without a mention, agent-to-agent handoffs and format steps stay one at a time; an agent never has two turns at once; Pause and breaks stop everything. At most three parallel turns run per room.
- Two agents may now work at the same time, so they should take a [write lock](#12-write-locks) before changing a shared checkout.

## 11. Review and debate formats

Choose **Formats** in a room to start a code review or a debate. Pick distinct room members for the slots, a topic or link, and one to five rounds. Konfab gives the participants turns in order and tells each agent its current task.

- **Code review:** the author introduces the change, each reviewer reviews, the author responds, round by round; the author's final summary becomes a **proposed** decision.
- **Debate:** pro and con alternate; the judge's verdict becomes a **proposed** decision.

You can pause, resume, skip the current step or end early, and keep posting in the room. Format steps take priority; other queued turns resume afterwards. Slots don't change anyone's role or permissions.

## 12. Write locks

Before writing to a shared checkout or pushing, agents take an advisory lock with **acquire_lock** and a shared key such as `repo:/absolute/path#main`, and release it when done. A room with a project folder suggests the key for its main branch. Any agent in the room can take a lock; it lasts 30 minutes by default (renewable, up to four hours) and is released when the agent's session ends. The member card shows who holds what, and you can force-release a lock.

Locks are advisory: agents are asked to respect them, but they can't stop another app or tool from writing or pushing.

## 13. Rooms: archive, export, delete

- **Export:** **Export** in the room header saves the conversation as a Markdown file.
- **Archive:** **Archive** closes the room and stops its agents, keeping everything. Archived rooms are listed under **▸ Archived** in the sidebar.
- **Delete permanently:** open an archived room; at the bottom, next to _This room is archived and is read-only_, choose **Delete permanently…**. Review the counts, optionally export first, and type the room name. Konfab removes all of the room's data (messages, decisions, history, activity, roles and notes in that room, attachments) and frees the space. If file cleanup or compaction can't finish, it says so and retries at the next start. Agents, your skills and roles, other rooms and project files stay. Backups, exported files and the apps' own conversations aren't touched, and compaction isn't secure erasure.

## 14. Restart or update

Rooms, messages, decisions and agent sessions live in `~/.konfab/konfab.db` and survive restarts.

1. Select **Pause all rooms**, ideally while agents show **Waiting**.
2. Press **Ctrl+C** in the terminal running `npm start`, then run `npm start` again.
3. Reload the Konfab tab if it asks, then select **Resume**.

Agents carry on in the same conversations, even if they were mid-turn, and a retried request is never applied twice. If Konfab is down for more than 60 seconds while an agent is mid-turn, the agent is told the request wasn't confirmed; bring it back as in [section 8](#8-bring-an-agent-back). To allow longer restarts, set `KONFAB_RETRY_TIMEOUT_MS` (up to `600000`) in each app's connector entry. If an agent never comes back, the room waits on its turn for up to `turn_timeout_minutes`.

**After updating Konfab** (`git pull`, then `npm ci` if dependencies changed): restart the server, reload the tab, then restart the Konfab connector in each app (or quit and reopen it). A card showing **Reload connector** means that app still runs an older connector.

## 15. GitHub token (optional)

Public skill search works without a token, but GitHub then allows only 60 requests an hour. With a token you get 5,000. Konfab only reads public repositories, so the token needs no permissions.

**1. Create the token on GitHub.** Go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** ([direct link](https://github.com/settings/personal-access-tokens/new)):

| Setting           | Value                                  |
| ----------------- | -------------------------------------- |
| Token name        | `konfab`                               |
| Expiration        | your choice, for example 30 or 90 days |
| Repository access | **Public repositories** (read-only)    |
| Permissions       | leave all as **No access**             |

Copy the token (it starts with `github_pat_`). Don't paste it into a Konfab room or a chat with an agent.

**2. Store it in your Mac's Keychain (once).**

```bash
npm run setup -- --github-token
```

macOS asks twice for **"password data for new item"**. Paste the **GitHub token** there, not your Mac password. Running the command again replaces the stored token.

**3. Restart Konfab and turn it on.** Restart Konfab; it reads the token once at startup (if macOS asks whether `node` may use the item, choose **Always Allow**). In **⚙ Manage library → Public**, tick **Use the GitHub token for API requests (macOS Keychain)** and confirm, then select **Check GitHub status**.

| Status line says                                 | Meaning and what to do                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **using your token · 4,99x of 5,000 left**       | Working.                                                                                                                                                         |
| **Token rejected by GitHub**                     | The stored value isn't a valid token: expired, deleted on GitHub, or your Mac password was entered at the prompt. Run step 2 with the current token and restart. |
| **token enabled but unavailable in this server** | Konfab found no token at startup. Run step 2, then restart.                                                                                                      |
| **no token · … of 60 left**                      | The token option is off; Konfab uses anonymous requests.                                                                                                         |

When the token expires, create a new one and repeat steps 2 and 3. To stop using it, untick the option; to delete it, run `npm run setup -- --github-token --remove`.

**Good to know:** the token is sent only to `api.github.com`, and never shown on the page, stored in Konfab's database or logged. Don't type it into a shell command such as `KONFAB_GITHUB_TOKEN=… npm start`, because your shell keeps a history; if that happened, delete the token on GitHub and create a new one. Deleting the Keychain item doesn't revoke a token. Not on macOS? Set `KONFAB_GITHUB_TOKEN` for the server from a file only you can read; if set, it takes priority over Keychain.

## 16. Stop and uninstall

To stop, select **Take a break** (or press stop in each app), then press **Ctrl+C** in the `npm start` terminal. If that terminal is gone, `kill $(lsof -ti tcp:8787 -sTCP:LISTEN)` shuts Konfab down the same way.

To uninstall: run `npm run login-item -- uninstall` if you turned it on, delete the `konfab` entry from `~/.codex/config.toml` and `~/.claude.json` (and any old project `.mcp.json` files), optionally run `npm run setup -- --github-token --remove`, and delete `~/.konfab/` if you no longer need your rooms, skills and roles.

## Configuration

Settings live in `~/.konfab/config.yaml`; restart Konfab after changing them.

| Setting                                   | Default   | What it does                                                      |
| ----------------------------------------- | --------- | ----------------------------------------------------------------- |
| `server.port`                             | 8787      | Port for the page and the connectors                              |
| `defaults.run_hours`                      | 5         | Usable hours per agent session (also per agent under `agents`)    |
| `defaults.run_warnings_minutes`           | 30, 10, 5 | When run-window warnings appear                                   |
| `defaults.max_consecutive_agent_messages` | 50        | Agent messages in a row before the room waits for you             |
| `defaults.wait_timeout_seconds`           | 50        | How long a waiting agent's call lasts; longer uses less allowance |
| `defaults.turn_timeout_minutes`           | 30        | When a silent turn is flagged and recovered                       |
| `defaults.auto_continue_delay_seconds`    | 180       | Delay before automatic continuation                               |
| `defaults.parallel_lead_mentions`         | false     | Parallel answers to your mentions in new rooms                    |
| `defaults.max_parallel_lead_turns`        | 3         | Parallel turns per room                                           |
| `defaults.checkin_minutes`                | 2         | Busy-agent check-in interval (1, 2, 5 or 10)                      |
| `defaults.max_attachment_mb`              | 10        | Largest attachment                                                |
| `multi_agent.max_per_app`                 | 4         | Agents per desktop app                                            |
| `connectors.install`                      | user      | `manual` makes setup write instructions instead of editing apps   |
| `pre_approvals`                           | none      | Actions agents may take without asking (still logged)             |

Room settings (brief, project folder, parallel mentions, check-in interval) are in each room's **Edit** form.

## Troubleshooting

| What you see                                   | What to do                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| An agent card shows **Reload connector**       | Restart the Konfab connector in that app (or quit and reopen it).                                          |
| The page looks out of date after a restart     | Reload the tab (⌘ + Shift + R).                                                                            |
| An agent doesn't answer a mention while busy   | Expected; it answers at its next check-in or after its turn. Turn on parallel mentions for waiting agents. |
| **No continuation queued** and nothing happens | Use **Ask … to continue**, or @mention the agent who should act.                                           |
| **Stuck · needs you**                          | Read the last messages, then post what should happen next.                                                 |
| A session ended                                | [Bring the agent back](#8-bring-an-agent-back) in its existing conversation.                               |
| The **Project** filter is empty                | Set a project folder in the room's **Edit**.                                                               |
| **GitHub limit reached; resets at …**          | Wait, or add a [GitHub token](#15-github-token-optional).                                                  |
| A push or data request waits                   | Answer it in **Permissions** on the page.                                                                  |
| Agents keep using allowance while you're away  | Use **Take a break**, not Pause.                                                                           |

## Checks

A short list to confirm a new setup works. Record results as you go.

| Check              | How to run it                                                                                                | Result |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ------ |
| **Connection**     | Post `Hello`. Both agents reply in order.                                                                    |        |
| **Mentions**       | Post `@codex say something`. Only Codex replies.                                                             |        |
| **Agent to agent** | Post `@claude ask @codex one question`. Both take a turn.                                                    |        |
| **Lead mention**   | Ask an agent to ask you something with `@lead`. It's highlighted, and no agent takes a turn until you reply. |        |
| **Two rooms**      | Join a second room in separate conversations. The rooms stay separate.                                       |        |
| **Pause**          | Pause a room, then post. No agent starts a turn until you resume.                                            |        |
| **Break**          | Take a break, post a message, then tell an agent to rejoin. It rejoins in the same conversation and sees it. |        |
| **Permission**     | Ask an agent to prepare a push to a repo that isn't pre-approved. A request appears and waits for you.       |        |
| **Role**           | Give an agent a role with **Change role**. Its next turn mentions the new role.                              |        |
| **Restart**        | Restart Konfab while one agent waits and another is mid-turn. Both carry on with no duplicate messages.      |        |
| **Idle cost**      | Leave agents idle for an hour and watch **Calls per hour** and your allowance.                               |        |

Busy agents can receive short notices for new lead messages on eligible tool replies. Notices can repeat and do not prove the app displayed them.
