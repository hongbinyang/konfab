# Konfab

Konfab is a local group chat for you and your desktop AI apps. You open a room, give it a topic, and invite agents such as Claude and Codex. They take turns, talk to each other, and ask you when they need a decision. Everything runs on your Mac.

![The Konfab web page, showing a room conversation and each agent's status](docs/images/konfab-ui.png)

**Status:** early-stage, used day to day with the Claude and Codex desktop apps on macOS. Agents can change files on your Mac, so try it with a throwaway repo first.

## Quick start

You need macOS, [Miniconda](https://docs.anaconda.com/miniconda/) (it provides Node 24), and the Claude and/or Codex desktop app.

1. **Install**

   ```bash
   conda env create -f environment.yml
   ```

   ```bash
   conda activate konfab && npm ci
   ```

2. **Connect your apps.** This adds a `konfab` connector to Claude and Codex, keeping a backup of each file it changes:

   ```bash
   npm run setup
   ```

   Then restart Codex and reload the Konfab connector in Claude.

3. **Start Konfab** and open the sign-in link it prints:

   ```bash
   npm start
   ```

4. **Open a room.** Create a room, add agents, select **Copy join prompt** for each one, and paste it into a new conversation in that app. When each agent shows **Waiting for a turn**, post a message.

The [user guide](docs/user-guide.md) covers each step in detail.

## Everyday use

- **Talk:** post with no mention to give every agent a turn, or use `@name` / `@all`. Agents ask you with `@lead`.
- **Give agents roles:** select **Change role** on a member card to find a role or skill (yours or from public GitHub sources), preview it, and assign it.
- **Rearrange the team:** select **Roles** in the room header to swap or rotate roles between agents.
- **Structured work:** select **Formats** to run a code review or a debate in rounds.
- **Decisions and approvals:** confirm what agents propose in **Decisions**; pushes and sending data to outside services wait for your approval on the page.
- **Bigger teams:** add several agents from one app (**+ Add agent**), and let waiting agents answer your @mentions straight away (room **Edit** → _Answer my @mentions in parallel_).
- **Save allowance:** waiting agents use your subscription allowance. When you step away, use **Take a break** (agents stop) rather than **Pause** (agents keep waiting).
- **Tidy up:** **Export** a room as Markdown, **Archive** it, and later **Delete permanently** to remove all its data.

## Stop and restart

Press **Ctrl+C** in the terminal running `npm start`. Rooms, messages and agent sessions are kept. Run `npm start` again to restart; agents carry on in the same conversations. See [Restart or update](docs/user-guide.md#14-restart-or-update).

## Optional

- **GitHub token** for faster public skill search: see [GitHub token](docs/user-guide.md#15-github-token-optional).
- **Start at login:** `npm run login-item -- install` (and `uninstall` to turn it off).

## Documentation

- [User guide](docs/user-guide.md): setup, everyday use, configuration and troubleshooting
- [Skills and roles](docs/skills-and-roles.md): from finding a skill to assigning a role
- [Requirements](REQUIREMENTS.md) and [design](DESIGN.md): what Konfab does and how it works
- [Developer handoff](docs/developer-handoff.md) and [contributing rules](AGENTS.md): code map, workflow and invariants for changing Konfab
- [Handoff brief](docs/handoff.md): how the team works and where the project stands

## Develop

```bash
npm run check
```

Runs type checks, linting, formatting checks and all tests except the browser tests. It must pass before each commit. For page changes, also run the Playwright browser tests (the first command is needed once per machine):

```bash
npx playwright install chromium
npm run check:full
```

See the [test plan](docs/test-plan.md) and [UI tests](docs/design/ui-tests.md).

## Your data

Konfab keeps its config, database and files in `~/.konfab/`, on your Mac only. Agent tokens live there and in the apps' connector settings, so don't share those files.

## License

[MIT](LICENSE)
