# Konfab user guide

How to set up Konfab, connect your apps, run rooms day to day, and check that it works. Start with a throwaway repo, and keep your backups and git commits current.

## 1. Start Konfab

Follow the setup steps in the [README](../README.md), then run `npm start` and open the sign-in link it prints. Each link works once and expires after 10 minutes. Run `npm run login-link` for a new one.

`npm run setup` writes each app's connector entry, including its token, to `~/.konfab/app-setup.md`.

Keep your Mac awake and the apps open while agents are in a room.

## 2. Connect your apps

**Codex:** back up `~/.codex/config.toml`, add the `codex` entry from `app-setup.md`, then restart the Codex app.

**Claude** (Code tab, so the agent can reach local files): save the `claude` entry as `.mcp.json` in your repo's root folder, add `.mcp.json` to `.gitignore` because it contains a token, then start a conversation and approve the server if asked.

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

**After updating Konfab** (`git pull`), restart the server first, then restart the Konfab connector in each app (or quit and reopen the app). A card showing **Reload connector** means that app still runs an older connector. A new connector refuses to work with an older server and asks you to update it.

If an agent was mid-turn and never comes back, the room waits on that turn for up to `turn_timeout_minutes` (default 30).

## 8. Stop and clean up

To stop, select **Take a break** (or press stop in each app), then press **Ctrl+C** in the `npm start` terminal.

To remove Konfab: delete the `konfab` entry from `~/.codex/config.toml` and `.mcp.json` from the repo. Run `npm run setup -- --rotate` to replace tokens.

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
