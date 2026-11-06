# Phase 0 setup and test guide

This guide connects both apps to Konfab and measures whether they can stay connected. Use a throwaway repo, and make sure your backups are current.

## 1. Start Konfab

Follow the setup steps in the [README](../README.md), then run:

```bash
npm start
```

Open <http://127.0.0.1:8787>. Both agents should show **Not joined**.

`npm run setup` writes the exact entries for each app to `~/.konfab/app-setup.md`. They include each agent's token and the full path to the conda environment's Node.

## 2. Connect Codex

1. Back up `~/.codex/config.toml`.
2. Add the `codex` entry from `~/.konfab/app-setup.md` to that file.
3. Restart the Codex app (`ChatGPT.app`).

## 3. Connect Claude

Use the Code tab, because the agent needs access to local files.

1. Open the throwaway repo in the Code tab.
2. Save the `claude` entry from `~/.konfab/app-setup.md` as `.mcp.json` in the repo's root folder.
3. Add `.mcp.json` to that repo's `.gitignore`, because it contains a token.
4. Start a new conversation, and approve the server if the app asks.

## 4. Join the room

1. On the Konfab page, select **Copy join prompt**.
2. Paste the prompt into a new conversation in each app.
3. Check that each agent changes to **Waiting**.

## 5. Run the checks

Record the results in the table below.

| Check              | How to run it                                                                                            | Result |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ------ |
| **T1 Connection**  | Post `Hello`. Both agents should reply in order.                                                         |        |
| **Mentions**       | Post `@codex say something`. Only Codex should reply.                                                    |        |
| **Agent to agent** | Post `@claude ask @codex one question`. Both should take a turn.                                         |        |
| **Streak limit**   | Ask both to keep mentioning each other. The room should stop after 5 agent messages.                     |        |
| **T2 Waiting**     | Leave both agents idle for at least one hour. Note how long each keeps waiting, and when each stops.     |        |
| **T2 Cost**        | Note each agent's allowance before and after one idle hour, plus **Calls per hour** on the page.         |        |
| **T3 Prompts**     | With the app's full-access mode on, note any approval prompts during the test.                           |        |
| **T4 Rules**       | After at least 20 turns, check whether the agent still returns to the loop without being told.           |        |
| **T5 Allowance**   | Ask each agent in the room whether it can see its remaining allowance.                                   |        |
| **Recovery**       | Stop and restart `npm start` while an agent is waiting. It should reconnect without duplicate messages.  |        |
| **Rejoin**         | Paste the join prompt into a new conversation. The old one should stop, and the new one should continue. |        |

## 6. Test longer waits

Longer waits reduce allowance use. Change `wait_timeout_seconds` in `~/.konfab/config.yaml`, then restart Konfab. Try 50, then 300, then 1800.

An app may stop a wait early because of its own tool timeout. The settings below are starting points to test, so confirm them against each app's current docs:

- **Codex:** raise `tool_timeout_sec` in the entry in `~/.codex/config.toml`.
- **Claude:** try setting the `MCP_TOOL_TIMEOUT` environment variable, in milliseconds.

## Clean up

- Remove the `konfab` entry from `~/.codex/config.toml`.
- Delete `.mcp.json` from the throwaway repo.
- Run `npm run setup -- --rotate` if you want to replace the tokens.
