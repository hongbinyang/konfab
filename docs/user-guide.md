# Konfab user guide

How to set up Konfab, run rooms with your AI apps day to day, and look after it. For a quick overview, start with the [README](../README.md). Keep your backups and git commits current: agents can change files on your Mac.

**Contents**

- Setting up: [1. Start Konfab](#1-start-konfab) · [2. Connect your apps](#2-connect-your-apps) · [3. Open a room](#3-open-a-room)
- Everyday use: [4. Talking in a room](#4-talking-in-a-room) · [5. Skills](#5-skills) · [6. Decisions and permissions](#6-decisions-and-permissions) · [7. Save allowance](#7-save-allowance) · [8. Bring an agent back](#8-bring-an-agent-back)
- Working as a team: [9. Several agents per app](#9-several-agents-per-app) · [10. Parallel answers to your mentions](#10-parallel-answers-to-your-mentions-experimental) · [11. Review and debate formats](#11-review-and-debate-formats) · [12. Write locks](#12-write-locks)
- Looking after Konfab: [13. Rooms: archive, export, delete](#13-rooms-archive-export-delete) · [14. Restart or update](#14-restart-or-update) · [15. GitHub token](#15-github-token-optional) · [16. Stop and uninstall](#16-stop-and-uninstall)
- Reference: [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Checks](#checks)

## 1. Start Konfab

Run `npm run quickstart` as in the [README](../README.md); later, `npm start` starts Konfab. Open the sign-in link it prints. Each link works once and expires after 10 minutes; run `npm run login-link` for a new one. `npm run doctor` checks the install and prints a fix for each problem, and changes nothing. On macOS, to start Konfab automatically at login, run `npm run login-item -- install` (`uninstall` to turn it off); on Linux use your own service manager.

Keep your computer awake and the apps open while agents are in a room.

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

**Setup options.** `npm run setup` is normally run once, and again after moving the checkout, upgrading Node or switching to a new version of Konfab. Every run is safe to repeat. Pass options after `--`, for example `npm run setup -- --rotate`.

| Option                    | What it does                                                                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_                  | Adds or updates the `konfab` connector for each app found (Codex if `~/.codex/` exists, Claude Code if `~/.claude.json` or `~/.claude/` exists), reusing existing tokens. It also turns on **room posts without asking** for Codex (below) unless you turned that off. |
| `--manual`                | Changes no app files: writes the connector entries to `~/.konfab/app-setup.md` for you to add yourself. Same as `connectors: { install: manual }` in `config.yaml`.                                                                                                    |
| `--rotate`                | Issues new agent tokens and updates both apps. Agents connected with the old tokens stop working until their connector reloads.                                                                                                                                        |
| `--migrate <folder>`      | Removes an old Konfab entry from that project folder's `.mcp.json` (one folder per run, with a backup); see below.                                                                                                                                                     |
| `--allow-room-posts`      | Turns room posts without asking back on for Codex after you turned it off.                                                                                                                                                                                             |
| `--ask-before-room-posts` | Turns off Konfab's default, remembered by later runs. It removes the setting only where Konfab can tell it set it; otherwise it leaves the existing setting and says so. Whether Codex then asks is decided by Codex's own settings.                                   |
| `--github-token`          | Stores an optional GitHub token in the macOS Keychain (see [section 15](#15-github-token-optional)); `--github-token --remove` deletes it.                                                                                                                             |

`npm run doctor` shows what is set up, and changes nothing.

**After setup changes an app's settings, restart that app to pick them up.** This is the recommended way; how each app picks up changes isn't something Konfab controls, and it hasn't been checked for every case.

- **Codex:** quit and reopen the Codex app.
- **Claude:** restart the Konfab connector in Claude's Code tab, or quit and reopen the app.
- **Then** give agents already in rooms their **rejoin** prompt from their cards.

Setup prints each file it changed (with a backup path); if you're unsure, restart the apps anyway.

**Moving from a project `.mcp.json`.** Earlier versions put Claude's connector in a project folder's `.mcp.json`. To switch: run `npm run setup` (it reuses your tokens), reload the connector in Claude, check that an agent can join from a **different** folder, then remove the old entry with `npm run setup -- --migrate /path/to/old/project` (one folder per command; it backs up the file and leaves other connectors alone). If setup can't find a token to reuse, it says so; restore the old configuration or run `--rotate`.

**Full access.** Each app has its own full-access setting. It lets agents work without approval prompts, and also lets them change anything on your Mac, so try it on a throwaway repo first. Konfab can't change an app's permissions.

**Room posts without asking (Codex, on by default).** So that room conversation flows, setup lets Codex post in Konfab rooms without asking you each time. It changes only Konfab's `post_message` in Codex's settings (`[mcp_servers.konfab.tools.post_message] approval_mode = "approve"`), with a backup. Everything else Codex does keeps its normal approvals, Konfab permission requests (secrets, anything leaving the room, pushes) still come to you, and the app's own review can still refuse. If you already set your own value for it, setup keeps yours. To turn Konfab's default off, run `npm run setup -- --ask-before-room-posts`; later runs remember that. It removes the setting only where Konfab can tell it set it, and otherwise leaves the existing setting and says so; Codex's effective approval is decided by its own settings. `npm run doctor` shows the current setting. Claude Code isn't changed yet; its equivalent hasn't been verified.

## 3. Open a room

1. On the Konfab page, create a room with a name and topic, and choose its agents.
2. Select **Edit** on the room to add a **Brief for agents** and, for a code project, its **Project folder** (an absolute path; it enables project skills and a suggested write-lock key).
3. Give each agent its skills with **Assign skills** on its card (see [section 5](#5-skills)). Tick **May edit files and repos** only for agents that should change code.
4. Select **Copy join prompt** for each agent and paste it into a new conversation in that app. Use one conversation per room.
5. Check that each agent shows **Waiting for a turn**, then post a message.

You are always the lead: agents are told to follow your instructions and decisions and to address you as `@lead`. Brief and skill changes apply from each agent's next turn. These are instructions, so an agent can still ignore them.

**Starting a fresh room for an existing project.** Long rooms slow agents down. To continue in a new room, put a short handoff file in the project (this repo uses [docs/handoff.md](handoff.md)), create the new room with the same project folder, point its brief at the handoff file, and paste fresh join prompts. Room messages and decisions don't carry over; anything in the repo does.

## 4. Talking in a room

- **Who answers:** a post with no mention gives each agent a turn in order. Use `@name` or `@all` to choose; `@name` is the agent's name in this room if you gave it one (see [section 9](#9-several-agents-per-app)), and its agent ID always works too. Agents mention you with `@lead`; such a message is highlighted and waits for you.
- **Handoffs:** agents say who goes next when they post (themselves, another agent, you, or done). Below the message box, **Taking a turn** and **Next** show who has the next step. **No continuation queued** means nobody was asked to continue; use **Ask … to continue** if work should go on.
- **Automatic continuation:** if an older connector posts without saying who is next, Konfab continues after three minutes (shown with a countdown and **Cancel**). At most three automatic recoveries per hour per room, then the room shows **Stuck · needs you**. You can turn this off per room.
- **Limits:** a room waits for you after 50 agent messages in a row.
- **Status:** an agent doing longer work shows **Working · N min: detail** on its card. A warning after `turn_timeout_minutes` means no progress update has arrived; it doesn't prove the agent stopped.
- **Unread:** new agent messages have a soft tint and a **New messages** divider. Room badges and the tab title show counts (**@** for mentions). **↓ N unread** jumps to the next unread reply; **Mark all read** (or Esc) clears the room.
- **Search and export:** search a room's messages, or **Export** it as a Markdown file.
- **Formatting:** formats show in the message box as you write, and the message looks the same when sent. Use the [shortcuts](#formatting-shortcuts), type the Markdown marks, or open **Formatting menu** (hidden until you open it; your choice is remembered). Tables, task lists, headings and code blocks are written as Markdown; the box shows live under the text how they will look. **Plain text** switches to a plain box.
- **Before sending:** if a format can't be sent as shown (for example bold directly between punctuation and a letter), Send first shows how the message will look, and you choose to keep editing, remove that formatting, or send it. Your text is never changed on its own; lines without formatting are sent exactly as typed.
- **Drafts:** each room keeps its own draft and files while you look at other rooms, until you close or reload the page. If a message can't be sent, it comes back to the box.
- **Attachments and emoji:** use the 📎 and 😊 buttons next to **Send**.
- **Right panel:** collapsible sections for Lead, Decisions, Agents, Permissions and Activity; your layout is remembered.
- After a server restart, a notice offers to reload the page.

### Formatting shortcuts

Also under **Shortcuts** below the message box. On Windows and Linux, use Ctrl for ⌘ and Shift for ⇧.

| Format                                        | Keys    | Or type                                 |
| --------------------------------------------- | ------- | --------------------------------------- |
| Bold                                          | ⌘B      | `**text**`                              |
| Italic                                        | ⌘I      | `_text_`                                |
| Strikethrough                                 | ⌘⇧X     | `~~text~~`                              |
| Code                                          | ⌘E      | `` `text` ``                            |
| Link                                          | ⌘K      |                                         |
| Bulleted list                                 | ⌘⇧8     | `-` and a space at the start of a line  |
| Numbered list                                 | ⌘⇧7     | `1.` and a space at the start of a line |
| Quote                                         | ⌘⇧9     | `>` and a space at the start of a line  |
| Normal text                                   | ⌘⇧0     |                                         |
| Leave a list or quote at the end              | ↓       |                                         |
| Leave bold, code or another format at the end | →       |                                         |
| Nest a list item                              | ⌘]      |                                         |
| Un-nest a list item                           | ⌘[      |                                         |
| New line in the same list item                | ⇧Enter  |                                         |
| Undo, redo                                    | ⌘Z, ⌘⇧Z |                                         |
| Send                                          | ⌘Enter  |                                         |

Press the same keys again to remove a format (for a link, choose **Remove link**). Ctrl+Y or ⌘Y also redoes. Backspace right after typing a mark takes the formatting back. Enter on an empty list item or quote line leaves it, one level at a time; **Normal text** leaves everything at once. Tab leaves the box.

### Notices on your phone (Telegram)

Off unless you set it up. While you are away from the Konfab page, Konfab can send short notices to your own Telegram chat: an agent mentioned @lead, a permission request is waiting, or a room has stopped. They never contain message text, files, links or agent names. Telegram carries them, so it sees them and when they are sent.

1. In Telegram, write to **@BotFather**, send `/newbot`, and make a bot **only for Konfab**.
2. Run `npm run setup -- --telegram` and paste the token when asked. It isn't shown, and macOS keeps it in your Keychain (elsewhere, set `KONFAB_TELEGRAM_TOKEN` for setup and the server from a file only you can read). Never post it in a room.
3. Setup shows a code to send to the bot from your phone, so it knows the chat is yours. It asks before contacting Telegram, before sending a test and before turning notices on.

- **When:** after 10 minutes without a click, key or scroll on the page; at most one notice per room in 10 minutes and 20 a day. Change this in **⚙ Settings → Phone notices**, or with `npm run config` (see [Configuration](#configuration)); it is in use at once.
- **Turn off:** the switch under **Lead** in the right panel, or in **⚙ Settings → Phone notices**. `npm run setup -- --telegram --remove` removes the chat and the stored token; tell @BotFather to end the bot.
- **One way:** after setup Konfab reads nothing from Telegram; writing to the bot does nothing.
- **Who can reach the token:** programs running as you that macOS lets read that Keychain item, which can include an agent that runs commands. With it, someone could send as this bot, but not use your Telegram account.

## 5. Skills

A **skill** is a folder with a `SKILL.md`, in the open Agent Skills format. A skill can describe responsibilities ("you are the reviewer…"), a procedure ("how to review a diff"), or both. Each agent has an ordered list of skills in each room, plus optional **room instructions**. Skills are instructions only: they never grant permissions, and Konfab never runs their scripts.

**Assign skills.** On the agent's card, select **Assign skills**. One search covers:

| Filter        | What it shows                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------- |
| **My skills** | Skills you saved, usable in any room (`~/.konfab/skills`)                                       |
| **Project**   | Skills stored in the room's project (`<project folder>/.konfab/skills`); needs a project folder |
| **Built-in**  | `pm`, `implementer`, `reviewer` and `qa`, shipped with Konfab (read-only)                       |
| **Public**    | Skills from GitHub sources enabled in **⚙ Manage library → Public**                             |

Select a result to preview it, then **Add** it. On the right, the selected skills are listed in order: use ↑/↓ to reorder and ✕ to remove. The agent follows room rules and your instructions first, then its skills in this order; when two skills conflict, the earlier one wins. For each skill, choose **Full text** (the whole `SKILL.md` is sent) or **Summary** (only its name and description; the agent reads it when needed). An agent can receive up to 64 KiB; the size meter shows how close you are, and **Assign** is blocked above it until you switch a skill to Summary or remove one. Confirming also marks any not-yet-reviewed revision as reviewed.

Public skills are searched live and nothing is saved while you browse. Assigning copies the skill into your library, pinned to the commit you previewed. Adding it again later reuses that copy; if the source has a newer commit, your unmodified copy gets a new revision. If you have edited your copy, Konfab asks: **Keep my version** (your saved revision is shown for review; unsaved changes are not included), or **Add as `name-2`**. It never overwrites your changes.

**Update a skill.** Edit a skill in **⚙ Manage library** (or in its folder) and **Save revision**. Agents keep the revision they were assigned until you update them: either on the card (**Update available** → **Show changes** → **Use rev N** → **Assign**), or for everyone at once in the library (open the skill → **Used by** → tick members → **Review and update**). Archived rooms are never updated.

**Rearrange the team.** Select **Team** in the room header. Drag a member's skills onto another member (or use **Swap with**) to swap; repeat to rotate; or remove a member's skills. A member's skills move together with its room instructions; its name, app and **May edit files** stay with it. Review the before-and-after list, then **Apply**.

Agents get their new skills and a short notice on their next turn, in the same conversation; an agent mid-turn finishes with what it had.

**Manage the library.** **⚙ Manage library** (sidebar) is for editing and organising: create and edit skills, save revisions, review them, restore history, rename, duplicate (also to make an editable copy of a built-in skill), Trash; see who uses a skill; manage public sources, the optional GitHub token and old downloaded indexes. For the full walkthrough, see [Skills](skills.md).

**Upgrading from roles.** Earlier versions of Konfab had roles. The first start of this version turns each role in use into a personal skill with the same text (adding `-role` to its name if the name is taken), and an agent's free-text role into its room instructions. It first writes a backup to `~/.konfab/backups/`. To preview the result without changing anything, run `npm run upgrade-check`. To undo: stop Konfab, move `konfab.db`, `konfab.db-wal` and `konfab.db-shm` aside, copy the newest backup to `konfab.db`, and start the previous version. Your old `~/.konfab/roles` folder is left as it was; you can delete it. Agents that joined before the upgrade keep working in their current conversations (checked with the Claude and Codex desktop apps); if one doesn't, take a break, reload the Konfab connector in its app and paste a fresh join prompt.

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

### Stop agents

**Stop agents** at the top of the room asks all its agents to leave the loop, for example in the evening. It first lists what each is told: now, or after its turn or work. Beside the participants you then see, for example, **Stop: 1 connector has it · 1 after its turn**; **Keep all** undoes it for those that haven't ended. It works in a paused room too.

### Stop one agent

**Stop agent** on an agent's card asks that agent to leave the room's loop. Nobody else is affected, its conversation stays, and **Rejoin** can bring it back.

| The agent                                    | Button                   | What happens                                                  |
| -------------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| Waits                                        | **Stop agent**           | its waiting call is answered with "stop"                      |
| Has a turn                                   | **Stop after turn**      | the turn finishes; the answer to its post or pass says "stop" |
| Reported work outside a turn                 | **Stop after this work** | it is told at its next wait                                   |
| Is asked to stop, and a turn or work goes on | **Keep in room**         | undoes it                                                     |

- **This isn't the app's own Stop button.** Work that already runs in the app isn't interrupted.
- **What the card says:** **Stop sent. Not confirmed.** Konfab has answered with "stop". **Stopped** means that the agent's connector has that answer. Konfab can't see whether its app has stopped. If the agent calls again, its calls are refused and the card says so.
- **Rejoin** can be used at once when it is **Stopped**, otherwise after 90 seconds without a call. While it is only asked to stop, Rejoin isn't offered, because it would replace a session that may be working.
- **If nothing is heard from it** while it is asked to stop: look in its app, select **Keep in room**, or paste the rejoin prompt. Pasting it replaces the session: a lock is released and a running turn is queued again; work that goes on in the app may then write at the same time.
- **Its work waits:** messages, hand-offs and review steps stay queued for it, and others go on. Nothing is given to somebody else. An answer to a permission that it asked for may go unused.
- **Its run window** goes on with the rest at the next join, as after a break.
- **If it joins again by itself** while you asked it to stop, the card and the room say that your Stop no longer applies.

## 8. Bring an agent back

You don't need a new conversation. In the agent's existing conversation, say:

| When                                                        | Say                                                |
| ----------------------------------------------------------- | -------------------------------------------------- |
| The session ended (run window over, a break, room archived) | `Rejoin Konfab room <room> and continue the loop.` |
| The agent stopped with an error                             | `Continue the Konfab loop in room <room>.`         |
| The card says **No contact** or **Working · no update**     | `Rejoin Konfab room <room> and continue the loop.` |

Konfab shows **No contact since 5:00 PM** when a waiting agent hasn't checked in for 90 seconds (the same rule Konfab uses to decide whose turn is next), or **Working · no update since …** when a busy agent misses two check-ins. During a long turn the card may say **Working · no contact since …**; a long command may still be running, so check the app before rejoining. Konfab can't tell why a conversation stopped (the app closed, it hit a limit, or the agent ended its reply), so it shows the last contact time and two buttons: **Copy rejoin prompt** copies a one-line "Rejoin Konfab room … and continue the loop." for the conversation that already joined, and **Copy full prompt** copies the full join prompt for a new conversation (or if the agent seems to have lost its instructions after a very long session). If you @mention an agent in that state, or one that hasn't joined, a note under the message box says so straight away.

Rejoining after a break restores the saved balance once; other rejoins start a fresh window. Paste the join prompt into a new conversation only if the old one has become very long or slow; the old one then stops by itself.

### The Rejoin button (Codex agents, macOS, experimental)

Instead of pasting the prompt, select **Rejoin** on a Codex agent's card, or **Rejoin agents** in the room's header for all that can be asked. Konfab asks the Codex app to bring back the conversation the agent last joined from. The manual prompts always stay. Claude agents have only those unless you turn on [theirs](#the-rejoin-button-for-claude-agents-macos-experimental-off). Konfab never does this by itself.

It can be used when the agent isn't waiting or working and its last join came through a connector that names its conversation, so **restart the Konfab connector once after this update**. Until then the card says so and copies the prompt instead. It uses the agent's allowance. `npm run doctor` says whether it is available, and why not.

| The card says                                      | What it means                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Rejoin asked 12:03 · waiting**                   | Codex took the prompt                                                                                                                     |
| **… Konfab couldn't tell whether Codex took it**   | It may be there or not; Konfab doesn't send it again                                                                                      |
| **Not back yet**                                   | Select **Open Codex** and look at its conversation. If it shows **Queue paused**, press **Resume** there                                  |
| **It says it was stopped in …**                    | The agent didn't come back because you stopped it in its app. Paste the rejoin prompt there                                               |
| **Codex didn't take it; nothing is waiting there** | Use the rejoin prompt                                                                                                                     |
| **Joined · waiting for its first check**           | It is in the room, but hasn't called `wait_for_turn` yet                                                                                  |
| **Joined, but not waiting yet**                    | Look at its conversation, or paste the rejoin prompt                                                                                      |
| **Rejoin closed**                                  | Cancelled, over 10 minutes old, or the room has changed (pause, break, archive, removal, another join), or the agent was in contact again |
| **Waiting for a turn**                             | It is back                                                                                                                                |

- **In a paused room or a break** the button is **Resume and rejoin** or **End the break and rejoin**. It first names what changes for the whole room and whose queued turns can start. If the agent then can't be asked, the room stays resumed, and the page says so.
- **When an agent that is away can't be asked,** the card has **Open Codex and copy the prompt** (or **Open Claude …**). Konfab asks the app to come to the front; choose the conversation and paste. Konfab can't see which conversation the app shows. If the agent has come back meanwhile, it says **Don't paste**. Off: `rejoin.open_apps: false`.
- **Rejoin agents** at the top of the room lists everyone who is away: those that can be asked, and those that need you.
- **A prompt can't be taken back.** Codex may deliver it hours later. It carries a one-time request that Konfab has closed by then, so the agent is told to end its turn and nothing changes in the room; that costs one short turn. If the model ignores this and joins in the ordinary way, Konfab can't tell that from a pasted prompt.
- **Sending a second one** while an earlier prompt may still be in Codex asks you first. Only the newest can rejoin.
- **What is sent:** a fixed text with that request, and nothing anyone wrote, not even the room's name.
- **What it protects against:** mistakes and late prompts, not a hostile program running as you, which could already use Codex and the connector.
- **What it runs:** only the Codex app's own command, after checking its place, owner, signature and version. Untried versions are off. **⚙ Settings → Rejoin** can change that, or `npm run config`. Another command isn't run before you have said yes to exactly that file; if the file changes, you are asked again. That it is signed is something to go by, not a guarantee.

When an agent that had joined before is really waiting again (not only told that the room is on a break or its run window is over), the room shows **… is back**, also after a pasted prompt.

Tested once in the Codex app's own window (conversation open, the agent had ended its turn). Not yet tested there after **Stop**, after a usage limit, or with a closed or archived conversation.

### The Rejoin button for Claude agents (macOS, experimental, off)

The Claude app has no way to put a prompt into an open conversation from outside. But it starts a conversation again when a background command **that the conversation itself started** ends. So, if you turn this on, a Claude agent starts one small command when it joins, a **watcher**. It waits silently, uses no allowance, and ends when you select **Rejoin**.

1. Turn on **⚙ Settings → Rejoin → Wake Claude agents**, or run `npm run config -- set rejoin.claude_watcher true`. Konfab needs no restart.
2. Restart the Konfab connector in Claude once, if you haven't since the update that brought this.
3. Paste the rejoin prompt from the card once (**Copy rejoin prompt**; it now has one more sentence, which asks for the watcher). Claude may ask you to allow the command.

| How Claude stopped                                                                 | **Rejoin**                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| It ended its own turn, for example after `@claude end your turn and stop the loop` | brings it back (tested once)                                        |
| You pressed **Stop**                                                               | may not: Stop tells Claude to wait for you. Paste the rejoin prompt |
| Claude was closed                                                                  | **Open Claude and copy the prompt**: the watcher ended with it      |
| A usage limit, a compacted conversation, hours of sleep                            | not tested                                                          |

- **What it runs:** `node …/konfab/dist/cli/watch.js …/.konfab/watch/<number>`, and nothing else. It reads that one file, calls only Konfab on this computer, and looks at the list of processes to end with the app.
- **Limits:** at most 3 for a conversation and 6 for the app. Old ones rest until Claude is closed, about 56 MB each; Konfab tells one to end, at most twice a day for a conversation, while its agent is waiting. Konfab never ends a process itself. If it can't tell that an old one is gone, it starts no new one, and the manual prompt works.
- **What is protected:** the same one-time request and checks as for Codex. The watcher's own ticket can only be told such a request; it can't join, read or post.
- **It relies on the model** doing what its prompt says. If it doesn't start the watcher, the card opens Claude and copies the prompt instead.
- **Turn it off:** the same switch. Open requests are closed, and watchers that are still there rest and wake nobody; one that was told a request a moment before can still start a short turn. Turned on again, each agent needs one join (paste its rejoin prompt).

## 9. Several agents per app

Every agent has two attributes: its **app** (the desktop app that runs it, such as Claude or Codex) and its **skills** in each room. You can have several agents on the same app, for example `claude` and `reviewer`.

To add one, choose **+ Add agent** at the top of the room's **Agents** panel. Enter a display name (the agent ID is filled in for you and is what you @mention), pick the **App**, and keep **Add to this room** ticked to choose its skills straight away with **Choose skills…** (the same picker as **Assign skills**). Then use the new card's **Copy join prompt** in a separate conversation in that app. Each card shows **App:** and **Skills:** chips; skills stay per room, so change them later with **Assign skills** or move them with **Team**.

Each agent has its own session, skills and turns. Agents of one app share that app's credential and account allowance: conversations in that app are trusted to act as any of its agents, so this is for organising a team, not a security boundary. The default limit is four agents per app (`multi_agent.max_per_app`). You can rename an agent's display name; to remove one, end its sessions first (its history stays).

**Names in a room.** Give an agent a short name for one room, such as `A` or `Reviewer`, in **Name in this room**: on the **+ Add agent** form, or on its card before it joins. That name is what you and the other agents type after @ (in any case), and the room shows it on cards, messages and pickers. Names start with a letter and use letters, digits, `-` or `_` (up to 32); `lead` and `all` are reserved, and a name can't match another member's name or agent ID. Once the agent joins the room its name is **Fixed**. Agents are told everyone's names on their next turn. Each room has its own names, and the agent ID still works as a mention. Hover over a card's name to see its agent ID and whether it is the app's default agent.

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

You can pause, resume, skip the current step or end early, and keep posting in the room. Format steps take priority; other queued turns resume afterwards. Slots don't change anyone's skill assignment or permissions.

## 12. Write locks

Before writing to a shared checkout or pushing, agents take an advisory lock with **acquire_lock** and a shared key such as `repo:/absolute/path#main`, and release it when done. A room with a project folder suggests the key for its main branch. Any agent in the room can take a lock; it lasts 30 minutes by default (renewable, up to four hours) and is released when the agent's session ends. The member card shows who holds what, and you can force-release a lock.

Locks are advisory: agents are asked to respect them, but they can't stop another app or tool from writing or pushing.

## 13. Rooms: archive, export, delete

- **Export:** **Export** in the room header saves the conversation as a Markdown file.
- **Archive:** **Archive** closes the room and stops its agents, keeping everything. Archived rooms are listed under **▸ Archived** in the sidebar.
- **Delete permanently:** open an archived room; at the bottom, next to _This room is archived and is read-only_, choose **Delete permanently…**. Review the counts, optionally export first, and type the room name. Konfab removes all of the room's data (messages, decisions, history, activity, skill assignments and room instructions, attachments) and frees the space. If file cleanup or compaction can't finish, it says so and retries at the next start. Agents, your skills, other rooms and project files stay. Backups, exported files and the apps' own conversations aren't touched, and compaction isn't secure erasure.

## 14. Restart or update

Rooms, messages, decisions and agent sessions live in `~/.konfab/konfab.db` and survive restarts.

1. Select **Pause all rooms**, ideally while agents show **Waiting**.
2. Press **Ctrl+C** in the terminal running `npm start`, then run `npm start` again.
3. Reload the Konfab tab if it asks, then select **Resume**.

Agents carry on in the same conversations, even if they were mid-turn, and a retried request is never applied twice. If Konfab is down for more than 60 seconds while an agent is mid-turn, the agent is told the request wasn't confirmed; bring it back as in [section 8](#8-bring-an-agent-back). To allow longer restarts, set `KONFAB_RETRY_TIMEOUT_MS` (up to `600000`) in each app's connector entry. If an agent never comes back, the room waits on its turn for up to `turn_timeout_minutes`.

**After updating Konfab** (stop the server, `git pull`, then `npm ci`; if you skip `npm ci` and the dependencies changed, `npm start` stops and says so): start the server, reload the tab, then restart the Konfab connector in each app (or quit and reopen it). A card showing **Reload connector** means that app still runs an older connector.

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

**Logs:** `~/.konfab/logs/konfab.log`, readable only by you. At 5 MB it becomes `konfab.log.1`; three older files are kept, so logs take at most about 20 MB. They record changes and problems, not routine requests, message text, tokens or sign-in links. If the log can't be written, Konfab keeps running. Only one running Konfab writes the log at a time. With start at login, other output such as a crash goes to `output.log`, at most 1 MB plus one older file. If you set up start at login with an earlier version, run `npm run login-item -- install` again; its old `server.log` is left as it is, and you can delete it. `npm run doctor` shows how much space the database, files, backups and logs use; Konfab deletes none of the others by itself.

To uninstall: run `npm run login-item -- uninstall` if you turned it on, delete the `konfab` entry from `~/.codex/config.toml` and `~/.claude.json` (and any old project `.mcp.json` files), optionally run `npm run setup -- --github-token --remove`, and delete `~/.konfab/` if you no longer need your rooms and skills.

## Configuration

Nothing needs configuring: every setting has a default. The server always listens on `127.0.0.1` only. There are three ways to change a setting; all use `~/.konfab/config.yaml`.

- **In the page:** **⚙ Settings** in the left sidebar. It has **Rejoin** and the options of **Phone notices**; the others are on the command line for now.
- **On the command line,** with Konfab running or not:

  ```
  npm run config                                  # all settings
  npm run config -- get rejoin.claude_watcher
  npm run config -- set rejoin.claude_watcher true
  npm run config -- reset phone_notices.away_minutes
  ```

- **In the file,** by hand.

Both the page and the command line say whether a change **is in use**: at once, from the next join, or after a restart. A running Konfab sees a change of the file within a few seconds, whoever made it. If the file can't be used, the earlier values stay and the page says why; a start with such a file stops and says why.

- **What is saved:** only what you change; the rest of the file, your comments and unknown keys stay. Adding a setting to a section can move blank lines there. The five versions before are in `~/.konfab/backups/config/`.
- **Don't edit the file while you save in the page or on the command line.** Konfab looks whether it has changed, but an editor that saves in the very last moment loses its save, and an editor that has the old text open overwrites Konfab's change.
- **A link** instead of the file is used at a start, but isn't changed or followed while Konfab runs.
- **Who can change settings:** you, in the page and on the command line. Agents have no way through Konfab. An agent that can run commands on your computer could edit the file, as before.

Environment variables (all optional):

| Variable                | Default          | What it does                                                                                    |
| ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `KONFAB_HOME`           | `~/.konfab`      | Where rooms, skills, the database and `config.yaml` live                                        |
| `CODEX_HOME`            | `~/.codex`       | Where setup finds Codex's `config.toml`                                                         |
| `CLAUDE_CONFIG_DIR`     | your home folder | Where setup finds Claude Code's `.claude.json`                                                  |
| `KONFAB_GITHUB_TOKEN`   | none             | GitHub token for public skill search (on macOS it can also be stored in the Keychain)           |
| `KONFAB_TELEGRAM_TOKEN` | none             | Bot token for [phone notices](#notices-on-your-phone-telegram) where there is no macOS Keychain |

Settings in `config.yaml`:

| Setting                                   | Default       | In the page | In use                    | What it does                                                                                    |
| ----------------------------------------- | ------------- | ----------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `phone_notices.away_minutes`              | 10            | yes         | At once                   | Minutes without activity before phone notices are sent                                          |
| `phone_notices.quiet_from`                | none          | yes         | At once                   | Start of quiet hours, such as 22:00; nothing is sent in them (needs both times)                 |
| `phone_notices.quiet_to`                  | none          | yes         | At once                   | End of quiet hours, such as 07:30                                                               |
| `phone_notices.room_names`                | false         | yes         | At once                   | Whether phone notices name the room, which Telegram then sees                                   |
| `phone_notices.room_every_minutes`        | 10            | yes         | At once                   | Minutes between two notices about the same room                                                 |
| `phone_notices.max_per_day`               | 20            | yes         | At once                   | Phone notices per day                                                                           |
| `rejoin.enabled`                          | true          | yes         | At once                   | Whether agents can be asked to rejoin; off closes requests that are open                        |
| `rejoin.claude_watcher`                   | false         | yes         | From the next join        | Asks Claude agents, when they join, to start one small background command that wakes them       |
| `rejoin.open_apps`                        | true          | yes         | At once                   | Lets a button bring Codex or Claude to the front (macOS)                                        |
| `rejoin.wanted_minutes`                   | 10            | yes         | At once                   | How long a request to rejoin stays wanted                                                       |
| `rejoin.allow_untested_version`           | false         | yes         | At once                   | Use a Codex version this hasn't been tried with                                                 |
| `rejoin.codex_command`                    | none          | yes         | At once                   | Absolute path of the Codex command, instead of the app's own copy; its signature isn't required |
| `defaults.run_hours`                      | 5             | no          | After a restart of Konfab | Usable hours per agent session (also per agent under agents)                                    |
| `defaults.run_warnings_minutes`           | 30, 10, 5     | no          | After a restart of Konfab | When run-window warnings appear                                                                 |
| `defaults.max_consecutive_agent_messages` | 50            | no          | After a restart of Konfab | Agent messages in a row before the room waits for you                                           |
| `defaults.parallel_lead_mentions`         | false         | no          | After a restart of Konfab | Parallel answers to your mentions in new rooms                                                  |
| `defaults.max_parallel_lead_turns`        | 3             | no          | After a restart of Konfab | Parallel turns per room                                                                         |
| `defaults.checkin_minutes`                | 2             | no          | After a restart of Konfab | Busy-agent check-in interval (1, 2, 5 or 10)                                                    |
| `defaults.wait_timeout_seconds`           | 50            | no          | After a restart of Konfab | How long a waiting agent's call lasts; longer uses less allowance                               |
| `defaults.turn_timeout_minutes`           | 30            | no          | After a restart of Konfab | When a silent turn is flagged and recovered                                                     |
| `defaults.auto_continue_delay_seconds`    | 180           | no          | After a restart of Konfab | Delay before automatic continuation                                                             |
| `defaults.max_message_chars`              | 20000         | no          | After a restart of Konfab | Characters in a message                                                                         |
| `defaults.max_decision_chars`             | 4000          | no          | After a restart of Konfab | Characters in a decision                                                                        |
| `defaults.max_attachment_mb`              | 10            | no          | After a restart of Konfab | Largest attachment                                                                              |
| `multi_agent.max_per_app`                 | 4             | no          | After a restart of Konfab | Agents per desktop app                                                                          |
| `server.port`                             | 8787          | no          | After a restart of Konfab | Port for the page and the connectors; run setup again after a change                            |
| `server.tick_seconds`                     | 30            | no          | After a restart of Konfab | How often the server looks for timeouts                                                         |
| `connectors.install`                      | user          | no          | At the next setup         | manual makes setup write instructions instead of editing apps                                   |
| `agents`                                  | claude, codex | no          | After a restart of Konfab | Agents that are made at the start, with their names and run hours                               |
| `pre_approvals`                           | none          | no          | After a restart of Konfab | Actions agents may take without asking (still logged)                                           |

Room settings (brief, project folder, parallel mentions, check-in interval) are in each room's **Edit** form.

## Troubleshooting

| What you see                                                                                | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An agent card shows **Reload connector**                                                    | Restart the Konfab connector in that app (or quit and reopen it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The page looks out of date after a restart                                                  | Reload the tab (⌘ + Shift + R).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| An agent keeps asking permission to post in the room, or passes with "waiting for approval" | Two different things can cause this. **1. A Konfab permission request** (it appears under **Permissions** on the right): check the recipient and data it names, and approve or deny it there. In our tests the agent then posted. **2. The agent's own app refused the post.** Agents are asked to report this; the report then appears on the agent's card with where to answer and suggested wording (the app decides). Without a report Konfab can't see it, so check the agent's app (the app shows a rejection, as in the Codex app's automatic approval review; Konfab shows nothing): approvals in the room may not count for that app. In the agent's app, type a specific approval naming the room and what may be posted, for example `I authorize you to post your reply about <topic>, including <details>, to the Konfab room "<room>".` The app's reviewer makes its own decision, so this can still be refused. Then ask the agent to continue. |
| An agent doesn't answer a mention while busy                                                | Expected; it answers at its next check-in or after its turn. Turn on parallel mentions for waiting agents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **No continuation queued** and nothing happens                                              | Use **Ask … to continue**, or @mention the agent who should act.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Stuck · needs you**                                                                       | Read the last messages, then post what should happen next.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A session ended                                                                             | [Bring the agent back](#8-bring-an-agent-back) in its existing conversation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The **Project** filter is empty                                                             | Set a project folder in the room's **Edit**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **GitHub limit reached; resets at …**                                                       | Wait, or add a [GitHub token](#15-github-token-optional).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A push or data request waits                                                                | Answer it in **Permissions** on the page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Agents keep using allowance while you're away                                               | Use **Take a break**, not Pause.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
| **Skills**         | Give an agent a skill with **Assign skills**. Its next turn includes the skill and a notice.                 |        |
| **Restart**        | Restart Konfab while one agent waits and another is mid-turn. Both carry on with no duplicate messages.      |        |
| **Idle cost**      | Leave agents idle for an hour and watch **Calls per hour** and your allowance.                               |        |

Busy agents can receive short notices for new lead messages on eligible tool replies. Notices can repeat and do not prove the app displayed them.
