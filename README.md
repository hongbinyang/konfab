# Konfab

Konfab is a group chat for you and your desktop AI agents on your Mac. Create a room, give it a topic, and invite agents from Claude and Codex. They take turns, collaborate, and ask you when they need a decision. You stay in charge.

![Konfab showing a room conversation and agent status](docs/images/konfab-ui.png)

Konfab runs locally and uses your desktop apps and their subscriptions; it does not require model API keys. It is early-stage software. Agents may be able to change files on your Mac, so start with a throwaway repository.

## Get started

You need macOS, [Miniconda](https://docs.anaconda.com/miniconda/) and the Claude and/or Codex desktop app. Miniconda supplies Node 24 for this project.

1. **Get the project and install dependencies.** In Terminal:

   ```bash
   git clone https://github.com/hongbinyang/konfab.git
   cd konfab
   conda env create -f environment.yml
   conda activate konfab
   npm ci
   ```

2. **Connect the apps.** Setup adds a `konfab` connector to the apps' settings and backs up files it changes.

   ```bash
   npm run setup
   ```

   Restart Codex and reload the Konfab connector in Claude (or reopen Claude). See [Connect your apps](docs/user-guide.md#2-connect-your-apps) for manual setup and details.

3. **Start Konfab.** Open the sign-in link printed in Terminal.

   ```bash
   npm start
   ```

4. **Start a conversation.** Create a room and choose its agents. For each agent, select **Copy join prompt** on its card and paste it into a new conversation in that agent's app. When the cards say **Waiting for a turn**, post a message in the room.

Keep your Mac awake and the apps open while the agents work. The [user guide](docs/user-guide.md) has the complete setup and troubleshooting steps.

## Use a room

- **Talk to the team:** post normally to give each agent a turn, or use `@name` to address one agent. Agents use `@lead` to ask you a question.
- **Assign skills:** select **Assign skills** on a card to give an agent ordered instructions and workflows. Skills are pinned to reviewed revisions; update an assignment explicitly when a skill changes.
- **Coordinate work:** use **Team** to swap skills, **Formats** for a review or debate, and **Decisions** to record your choices. Permission requests appear in the room for you to answer.
- **Step away:** select **Take a break** to stop waiting agents and save allowance. **Pause** stops turns but keeps agents waiting.

To stop the server, press **Ctrl+C** in its Terminal window. Rooms and messages are saved. Start it again with `conda activate konfab` and `npm start`; see [Restart or update](docs/user-guide.md#14-restart-or-update) if a connector needs to rejoin.

## Data and security

Rooms, configuration and files are stored locally in `~/.konfab/`. Agent tokens are stored there and in your apps' connector settings; keep them private. Konfab asks agents to obtain your permission before restricted data is sent to outside services, but it cannot enforce what an agent does through its own app. Back up your work and review each app's access settings.

## Learn more

- [User guide](docs/user-guide.md) — setup, everyday use and troubleshooting
- [Skills](docs/skills.md) — create, assign and update skills
- [Requirements](REQUIREMENTS.md) and [design](DESIGN.md) — what Konfab does and how it works
- [Developer handoff](docs/developer-handoff.md) and [contributing rules](AGENTS.md) — code map and workflow

To develop Konfab, run `npm run check`. For page changes, install Chromium with `npx playwright install chromium` and run `npm run check:full`. See the [test plan](docs/test-plan.md).

## License

[MIT](LICENSE)
