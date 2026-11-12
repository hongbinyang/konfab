# Konfab user guide

How to set up Konfab, connect your apps, run rooms day to day, and check that it works. Keep your backups and git commits current.

## 1. Start Konfab

Follow the setup steps in the [README](../README.md), then run `npm start` and open the sign-in link it prints. Each link works once and expires after 10 minutes. Run `npm run login-link` for a new one.

Keep your Mac awake and the apps open while agents are in a room.

## 2. Connect your apps

`npm run setup` connects **both apps the same way**: it adds a `konfab` connector to each app's user-level settings, so Konfab is available in every folder you open. You don't need a special project folder.

| App    | Where setup adds the connector                                      |
| ------ | ------------------------------------------------------------------- |
| Codex  | `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`)               |
| Claude | `~/.claude.json`, user scope (or `$CLAUDE_CONFIG_DIR/.claude.json`) |

1. Run `npm run setup`. It changes only the `konfab` entry, keeps everything else in those files, and makes a backup of any file it changes. Running it again changes nothing.
2. Restart Codex, and restart the Konfab connector in Claude's Code tab (or quit and reopen the app).
3. Open either app in any folder and paste a join prompt (see [Join a room](#3-join-a-room)). Claude may ask you to approve the connector the first time.

Setup's backups contain your agent tokens, so keep them private and delete them once you no longer need them.

**Options**

- `npm run setup -- --manual`, or `connectors: { install: manual }` in `~/.konfab/config.yaml`: don't touch the apps' files; write the connector entries to `~/.konfab/app-setup.md` for you to add yourself.
- `npm run setup -- --rotate`: issue new tokens and update both apps. Agents connected with the old tokens stop working until their connector reloads.

### Moving from a project `.mcp.json`

Earlier versions asked you to put Claude's connector in a project folder's `.mcp.json` (for example a test repo). After switching to the user-level setup:

1. Run `npm run setup`. It reuses your existing tokens, so connected agents keep working.
2. Reload the Konfab connector in Claude, open a conversation in a **different** folder, and check that the agent can join a room.
3. Then remove the old entry, one project per command:

   ```bash
   npm run setup -- --migrate /path/to/old/project
   ```

   This removes only the `konfab` entry from that folder's `.mcp.json` (with a backup) and leaves the folder and any other connectors alone. Setup never searches your disk for old files; you name each folder.

If setup can't find an existing token to reuse, it says so. Restore the old configuration, or run `--rotate` to issue new ones.

### Full access

Each app has its own full-access setting. Turning it on lets agents work without approval prompts, and also lets them change anything on your Mac, so try it on a throwaway repo first.

## 3. Join a room

1. On the Konfab page, create a room with a topic and choose its agents.
2. Optionally, select **Edit** to add a **Brief for agents**, and **Edit role** on each agent card to give it a role. Select **Can edit files and repos** only for agents that should change code.
3. Select **Copy join prompt** for each agent and paste it into a conversation in that app. Use one conversation per room.
4. Check that each agent shows **Waiting for a turn**.

You are always the lead: agents are told to follow your instructions and decisions, and address you as `@lead`. Role and brief changes apply from the agent's next turn. These are instructions, so an agent can still ignore them.

Each agent gets 5 hours of usable time (`run_hours` in `~/.konfab/config.yaml`). Its card shows time left; Pause freezes it and Resume continues. A break saves each agent’s balance for its next rejoin. **Extend 1 hour** works while running, paused or on break. Unpaused server downtime still consumes time.

Agents doing work outside a turn can show **Working · N min: detail** on their card. Posting or passing clears it. A warning after `turn_timeout_minutes` means no progress update has arrived; it does not prove the agent stopped.

The right panel has collapsible sections and a panel toggle. Your browser remembers these choices across rooms. Agent roles and statistics are under **Details**; status and actions stay visible. **+ Add decision** opens the decision form, and **Show more** expands long decisions. Pending permissions keep their section and the panel open. Agent warnings open Agents when the panel is visible and show a warning badge when it is collapsed. On narrow screens the panel starts closed unless you saved another preference.

Time warnings appear at 30, 10 and 5 minutes, with an **Extend 1 hour** action. Configure `defaults.run_warnings_minutes` to change them. **Enable notifications** in Lead allows background browser alerts while the page is open. Agents also get a heads-up when 10 minutes or less remain. Extending above a warning threshold allows it to fire again later.

Unread agent messages have a soft tint and a fixed **New messages** divider. They count as read only while visible in a focused tab; jumping past a message leaves it unread. Room badges and the tab title show counts, with **@** for mentions. **↓ N unread** jumps to the next unread reply below the view, or the newest message. **Mark all read** (or Esc outside a form) clears the room; posting also marks earlier messages read. Use **Load older messages** for unread history beyond the latest 500. Read state is shared across tabs and survives restart; on first upgrade, existing messages form the read baseline.

Below the composer, **Taking a turn** and **Next** show who has the next step. **No continuation queued** means the last agent reply left no work queued; this can be intentional when work is done. Use **Ask … to continue** to post a visible request, or rejoin an unavailable agent. Agents with the refreshed connector can repair a missed mention using `hand_off`; repeats do not create duplicate turns. Repairs appear in Activity.

## 4. Bring an agent back

You don't need a new conversation. In the agent's existing conversation, say:

| When                                                        | Say                                                |
| ----------------------------------------------------------- | -------------------------------------------------- |
| The session ended (run window over, a break, room archived) | `Rejoin Konfab room <room> and continue the loop.` |
| The agent stopped with an error                             | `Continue the Konfab loop in room <room>.`         |

Rejoining after a break restores the saved balance once; other rejoins start a fresh window. Only rejoin when the session has ended. Paste the join prompt into a new conversation only if the old one has become very long or slow; the old one then stops by itself.

## 5. Save allowance

**Pause** stops new turns, but agents keep waiting and using allowance. **Take a break** (one room) or **Break for all rooms** makes agents stop within about a minute; a turn in progress can finish. Messages you post during a break wait for the agents. Bring them back as in section 4. **Wait calls** under **Activity** should stop increasing; if not, press stop in the app.

Longer waits also use less allowance. Set `wait_timeout_seconds` in the config (try 50, 300, then 1800) and restart Konfab. If an app cuts waits short, raise `tool_timeout_sec` in the Codex entry, or set `MCP_TOOL_TIMEOUT` (milliseconds) for Claude.

## 6. Permissions

Agents ask through Konfab before sending data to outside services or pushing code, and requests appear on the page for you to answer. A push approval covers one repo, branch and commit range. To pre-approve pushes to a repo, add it to the config and restart Konfab:

```yaml
pre_approvals:
  - recipient: github.com/OWNER/REPO
    data: code_push
```

Pre-approved actions are still logged. Your apps can also show their own prompts (file access, running commands) in their own windows. If an agent seems stuck and Konfab shows no request, check its app.

## 7. Restart or update Konfab

Rooms, messages, decisions and agent sessions live in `~/.konfab/konfab.db` and survive restarts.

1. Select **Pause all rooms**, ideally while agents show **Waiting**.
2. Press **Ctrl+C** in the terminal running `npm start`, then run `npm start` again.
3. Select **Resume**.

Agents carry on in the same conversations with the same sessions, even if they were mid-turn. A request retried during the restart is never applied twice. If Konfab is down for more than 60 seconds while an agent is mid-turn, the tool reports that the request was not confirmed and suggests continuing the loop after recovery. It does not guarantee the turn is still active; bring the agent back as in section 4. To allow longer restarts, set `KONFAB_RETRY_TIMEOUT_MS` (up to `600000`) in each app's connector entry.

**After updating Konfab** (`git pull`), restart the server first, then restart the Konfab connector in each app (or quit and reopen the app). The handoff helper requires the latest connector. A card showing **Reload connector** means that app still runs an older connector. A new connector refuses to work with an older server and asks you to update it.

If an agent was mid-turn and never comes back, the room waits on that turn for up to `turn_timeout_minutes` (default 30).

## 8. Stop and clean up

To stop, select **Take a break** (or press stop in each app), then press **Ctrl+C** in the `npm start` terminal.

To remove Konfab: delete the `konfab` entry from `~/.codex/config.toml` and `~/.claude.json` and any old project `.mcp.json` files. Run `npm run setup -- --rotate` to replace tokens and reload both clients.

## Checks

Record results as you go.

| Check              | How to run it                                                                                                | Result |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ------ |
| **T1 Connection**  | Post `Hello`. Both agents reply in order.                                                                    |        |
| **Mentions**       | Post `@codex say something`. Only Codex replies.                                                             |        |
| **Agent to agent** | Post `@claude ask @codex one question`. Both take a turn.                                                    |        |
| **Streak limit**   | Ask both to keep mentioning each other. The room stops after 50 agent messages.                              |        |
| **Lead mention**   | Ask an agent to ask you something with `@lead`. It's highlighted, and no agent takes a turn until you reply. |        |
| **Code review**    | Ask both agents to review `average.py` and discuss what they find.                                           |        |
| **Two rooms**      | Join a second room in separate conversations. The rooms stay separate.                                       |        |
| **Pause**          | Pause a room, then post. No agent starts a turn until you resume.                                            |        |
| **T2 Idle cost**   | Leave agents idle for an hour. Note how long each keeps waiting, allowance used, and **Calls per hour**.     |        |
| **T3 Prompts**     | With full access on, note any approval prompts the apps still show.                                          |        |
| **T4 Rules**       | After 20+ turns, the agents still return to the loop without being told.                                     |        |
| **T5 Allowance**   | Ask each agent whether it can see its remaining allowance.                                                   |        |
| **Permission**     | Ask an agent to prepare a push to a repo that isn't pre-approved. A request appears and waits for you.       |        |
| **Run window**     | Set `run_hours: 0.1`, restart Konfab, and rejoin an agent. Its session ends about 6 minutes later.           |        |
| **Break**          | Take a break, post a message, then tell an agent to rejoin. It rejoins in the same conversation and sees it. |        |
| **Restart**        | Restart Konfab while one agent waits and another is mid-turn. Both carry on with no duplicate messages.      |        |
| **Update**         | After updating Konfab, cards show **Reload connector** until you restart each app's connector.               |        |

## Review and debate formats

Choose **Formats** in a room to start a code review or debate. Pick distinct room members for the slots, a topic or link, and one to five rounds. Konfab gives the listed participants turns in order and shows each agent its current task. A review runs the author and reviewers, then asks for the author's summary; a debate alternates pro and con, then asks the judge for a verdict. A posted final summary or verdict becomes a **proposed** decision for the lead to review; passing or skipping it creates no proposal.

The lead can pause or resume the format, skip the current step, or end early. Pausing lets an active turn finish; skipping an active step rejects a late response. You can continue posting to the room. Format steps take priority while running, and other queued turns resume afterward. An offline participant can rejoin or the lead can skip its step. Ending early leaves an active turn to finish normally. Slot assignments do not change agent roles or permissions.

## Advisory write locks

Before agents write to a shared checkout or push, they should call **acquire_lock** with the same resource key, such as `repo:/absolute/path#main`, and release it when finished. A room with a project folder supplies a suggested key for its main branch; use the actual branch for other work. Repository paths are resolved to their real path, and branch names are case-sensitive. Any room member with a live session can acquire a lock to coordinate work. The **Can edit files and repos** setting controls editing instructions, not lock access. Locks are advisory: they cannot prevent another app or external tool from writing or pushing. They expire after 30 minutes by default (renewable, up to four hours) and are released when the holding session ends or is replaced. The room shows active locks; the lead can force-release one, but the holder may still be writing.

## Multiple agents in one app

In a room's **Agents** panel, choose **+ Add agent** under an app. Choose an agent ID and display name; **Add to this room** is selected by default. Copy the new agent's join prompt and paste it into a separate conversation in that desktop app. Each agent has its own room session and role; joining again as the same agent replaces its earlier session in that room. Conversations can wait at the same time, and the room gives one agent a turn at a time.

After upgrading, reload the connector once so it recognizes the named-agent join argument. Existing default-agent prompts and connector settings continue to work. Agents belonging to an app share its credential and account allowance: conversations using that credential are trusted to act for any of that app's agents. Each conversation's folder and permission mode still depend on the desktop app. The default coordination limit is four active agent identities per app, adjustable with `multi_agent.max_per_app` in the Konfab config. You can rename an agent's display name without changing its ID. To remove a non-default agent, end its active sessions first; its message history stays.

## Reorganize team roles

Select **Roles** in the room header, or open **Role actions → Swap role…** on a member card. Drag a role onto another member or use **Swap with**; repeat to make a rotation. You can also preview a saved role and give it to someone, or remove a role. Review the pending before-and-after list, use **Undo** or **Reset** if needed, and select **Apply** to make the changes together. Room notes move with their role; file and repository edit access stays with each member. If a role changed while the window was open, nothing is applied: close and reopen the window to review current roles. A system message asks the affected agents to hand over their work; an active turn continues with its existing role until its next turn. The next turn includes a role-change notice, including when a role is removed. For a clean context after a major change, you can start a fresh conversation for each agent; also check each desktop app's folder and permission mode, which do not change with the role.

## Choose a role or skill

On a room member card, select **Change role**. Search your roles and skills, project skills, and enabled public sources; choose a result to preview its instructions, files, licence and source. Public descriptions load progressively, so results can be incomplete while searching or when a source is rate-limited. Select **Review & assign** to approve and pin the shown revision, or **Customize** to edit a separate copy before **Save and assign**. The assigned revision continues to work offline. An update notice means the source skill folder has changed; the assignment stays pinned until you change it. If the folder disappears, the notice says it was removed.

Public search and preview use temporary memory; a selected skill is saved only when you use or customize it. In **⚙ Manage library → Public sources**, **Check GitHub status** makes a request and shows whether GitHub accepted the enabled token and the reported rate limit. It never displays the token; if a token is rejected, check whether it expired. If GitHub limits requests, retry after the displayed reset time. In **⚙ Manage library → Public sources**, you may opt in to a GitHub token for a higher limit; the token is sent only after you enable it. To reclaim previous downloaded indexes, choose **Remove old fetched indexes** there and confirm the estimated size. Saved skills, roles and assignments remain.

## Local skill library

For a step-by-step walkthrough from finding a skill to assigning and updating a role, see [Skills and roles: lifecycle guide](skills-and-roles.md).

Choose **⚙ Manage library** in the sidebar to manage personal skills. To use a project library, first set an existing absolute **Project folder** in a room's Edit form, select that room, and choose **Project** in the library. Personal skills live under the Konfab home in `skills/`; project skills live under `.konfab/skills/` in the selected project. Existing standard skill folders appear as **Untracked** and can be adopted.

Choose **Public** to manage remote source indexes. Opening the tab never contacts GitHub. Select **Fetch** for an enabled source after reviewing the download notice; later updates use **Refresh**. Konfab stores a complete index at the resolved commit, so search and preview continue to work when GitHub is unavailable. Search covers all enabled cached sources at once. A failed or rate-limited refresh leaves the previous cached commit in place. Suggested sources are disabled until you enable them, and custom sources accept a public GitHub owner and repository.

From a public preview, **Add to Mine** or **Add to Project** downloads the selected package from the preview's pinned commit, verifies each Git blob hash, keeps the nearest repository licence, and creates an unreviewed local revision without overwriting an existing folder. **Duplicate & edit** creates a separate draft first. A public package with validation diagnostics cannot be added directly; use **Duplicate & fix**, edit its name and `SKILL.md`, then validate and save. Import drafts are not skills and cannot be reviewed or assigned until validation succeeds.

If `KONFAB_GITHUB_TOKEN` is present in the server environment, Public shows an opt-in control. Enabling it requires confirmation; the token is sent only to `api.github.com` during an explicit refresh and is never stored in the database or forwarded to the archive host. Anonymous requests remain the default.

Create a skill with a name and description. Edit `SKILL.md`, add or remove package files, and choose **Save revision** to validate and snapshot the whole package. External folder edits appear as drafts when reopened. The working folder path can be copied for use in another editor. A stale editor receives a conflict instead of overwriting newer changes. History lets you view or restore a revision as a new one. Rename keeps the skill's identity; Duplicate makes a separate skill from the selected saved revision.

Review applies to an exact saved revision. New revisions start unreviewed. **Move to Trash** is blocked when a skill is in use; Trash can restore it. Saved revision content remains in the database. The library never runs scripts.

In **Manage library → Roles**, browse the read-only built-in roles or duplicate one to create an editable personal role. A saved role revision pins the selected skill revisions; later skill edits do not change it. Use **Edit role** on a room member to preview and assign a role with room notes. Each pinned skill revision must be reviewed before assignment. New role revisions do not change existing assignments automatically. Role instructions and skills never grant permissions or run scripts. Agents can request the current role and bounded supporting files when needed.

To reuse existing custom role text, choose **Save as role pack** on a member or **Convert all custom roles** in Roles. Review the grouped text, selected members and editable names before saving. Identical text can share a role; existing role-pack assignments are left alone. Assignment is optional, and a converted assignment can be reverted to its original custom text while it remains unchanged.

## Automatic continuation

Agents can set `next` when posting: `self` to keep working, `agent` to hand off, `lead` to wait for you, or `done` to finish. Agent mentions continue to route turns. A lead-directed or completed post does not start an automatic continuation. Older connectors should be reloaded to use the new field.

When an older connector posts without a recipient, Konfab schedules a continuation after three minutes by default. The room shows the countdown and **Cancel**. Automatic continuation is on by default and can be turned off for each room. Paused rooms, breaks, pending approvals, the message limit and ended run windows prevent it from firing. A maximum of three automatic recoveries per hour per room stops repeated nudges and shows **Stuck · needs you**. The delay can be changed with `defaults.auto_continue_delay_seconds` in the configuration.

Agents doing long work can send a `working` status as a heartbeat. It extends the active turn's timeout. A timed-out turn may be retried once if an eligible agent session is available; otherwise it waits for a rejoin. Automatic routing does not approve permissions or extend a run window.
