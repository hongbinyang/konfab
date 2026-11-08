# Konfab user guide

This guide explains how to set up Konfab, connect your apps, use rooms day to day, and run the end-to-end checks. Start with a throwaway repo, and make sure your backups are current with Time Machine and frequent git commits.

## 1. Start Konfab

Follow the setup steps in the [README](../README.md), then run:

```bash
npm start
```

Open the sign-in link that it prints. Each link works once and expires after 10 minutes. To create another one, run:

```bash
npm run login-link
```

`npm run setup` writes the exact entries for each app to `~/.konfab/app-setup.md`. They include each agent's token and the full path to the conda environment's Node.

Keep your Mac awake and the apps open while agents are in a room.

## 2. Connect Codex

1. Back up `~/.codex/config.toml`.
2. Add the `codex` entry from `~/.konfab/app-setup.md` to that file.
3. Restart the Codex app (`ChatGPT.app`).

## 3. Connect Claude

Use the Code tab, because the agent needs access to local files.

1. Open your repo in the Code tab.
2. Save the `claude` entry from `~/.konfab/app-setup.md` as `.mcp.json` in the repo's root folder.
3. Add `.mcp.json` to that repo's `.gitignore`, because it contains a token.
4. Start a new conversation, and approve the server if the app asks.

## 4. Turn on full access

Each app has its own permission setting. Turn on its full-access mode yourself if you want agents to work without approval prompts. Agents can then change anything on your Mac without asking, so try it on a throwaway repo first.

## 5. Join a room

1. On the Konfab page, create a room with a topic, and choose its agents.
2. Optionally, select **Edit** to add a **Brief for agents** with the room's goals and constraints.
3. In each agent's card, select **Edit role** to give it a role in this room. You can start from a preset such as Reviewer or Implementer. To let only certain agents change code, select **Can edit files and repos** for them.
4. Select **Copy join prompt** for an agent, and paste it into a new conversation in that app.
5. Check that the agent changes to **Waiting**.

You are always the lead. Agents are told to follow your instructions and decisions, and roles and briefs apply from each agent's next turn, with no need to rejoin. Like all of Konfab's rules, these are instructions, so an agent can still ignore them.

Use a separate app conversation for each room. Agents stop when their hours end, so paste the join prompts again the next day. To keep working past an agent's hours, select **Open for 1 hour**, then paste its join prompt if it has already stopped.

## 6. Run the checks

Record the results in the table below.

| Check              | How to run it                                                                                                                                           | Result |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **T1 Connection**  | Post `Hello`. Both agents should reply in order.                                                                                                        |        |
| **Mentions**       | Post `@codex say something`. Only Codex should reply.                                                                                                   |        |
| **Agent to agent** | Post `@claude ask @codex one question`. Both should take a turn.                                                                                        |        |
| **Streak limit**   | Ask both to keep mentioning each other. The room should stop after 5 agent messages.                                                                    |        |
| **Code review**    | Ask both agents to review `average.py` and discuss what they find.                                                                                      |        |
| **Two rooms**      | Join a second room with new conversations. Each room should stay separate.                                                                              |        |
| **Pause**          | Pause a room, then post. No agent should start a turn until you resume.                                                                                 |        |
| **T2 Waiting**     | Leave both agents idle for at least one hour. Note how long each keeps waiting, and when each stops.                                                    |        |
| **T2 Cost**        | Note each agent's allowance before and after one idle hour, plus **Calls per hour** under **Activity**.                                                 |        |
| **T3 Prompts**     | With full access on, note any approval prompts during the test.                                                                                         |        |
| **T4 Rules**       | After at least 20 turns, check whether the agent still returns to the loop without being told.                                                          |        |
| **T5 Allowance**   | Ask each agent whether it can see its remaining allowance.                                                                                              |        |
| **Permission**     | Ask an agent to prepare a push to a repo that isn't pre-approved. A request should appear on the page, and it should wait for your answer.              |        |
| **Hours**          | Set an agent's end time a few minutes ahead in `~/.konfab/config.yaml`, then restart Konfab. The agent should stop at that time.                        |        |
| **Break**          | Select **Take a break**. Both agents should stop calling tools. Post a message, then paste a join prompt. The agent should rejoin and see your message. |        |
| **Recovery**       | Stop and restart `npm start` while an agent is waiting. It should reconnect without duplicate messages.                                                 |        |
| **Rejoin**         | Paste the join prompt into a new conversation. The old one should stop, and the new one should continue.                                                |        |

## 7. Save allowance with a break

**Pause** stops new turns, but agents keep waiting and using allowance. To save allowance, select **Take a break** for one room, or **Break for all rooms**. Agents stop as soon as they next check in, usually within about a minute, and a turn in progress can finish.

Messages you post during a break wait for the agents. To bring an agent back, select **Copy join prompt** and paste it into its app. The first agent to rejoin ends the break for that room.

Check that it worked by watching **Wait calls** under **Activity**, which should stop increasing. If an agent keeps calling tools, press stop in its app.

## 8. Test longer waits

Longer waits reduce allowance use. Change `wait_timeout_seconds` in `~/.konfab/config.yaml`, then restart Konfab. Try 50, then 300, then 1800.

An app may stop a wait early because of its own tool timeout. The settings below are starting points to test, so confirm them against each app's current docs:

- **Codex:** raise `tool_timeout_sec` in the entry in `~/.codex/config.toml`.
- **Claude:** try setting the `MCP_TOOL_TIMEOUT` environment variable, in milliseconds.

## 9. Pre-approve actions

To let agents push to a GitHub repo without asking each time, add it to `~/.konfab/config.yaml`, then restart Konfab:

```yaml
pre_approvals:
  - recipient: github.com/OWNER/REPO
    data: code_push
```

Agents still use `request_permission` for these actions, so each one is logged.

## Stop Konfab

1. Select **Take a break** or press stop in each app, so agents don't keep retrying.
2. Press **Ctrl+C** in the terminal running `npm start`.

## Clean up

- Remove the `konfab` entry from `~/.codex/config.toml`.
- Delete `.mcp.json` from the repo.
- Run `npm run setup -- --rotate` if you want to replace the tokens.
