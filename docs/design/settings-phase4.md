# Settings, phase 4: connectors, Codex posts and start at login

**Status:** a plan for review; nothing is built. It finishes [Settings](settings.md): after it, every setting and every setup action of today is in the page and on the command line, except the first setup and the first sign-in, which happen before the page can be reached.

These three change **other programs' files**: Codex's `config.toml`, Claude Code's `.claude.json`, and a macOS LaunchAgent. So every change in the page is shown first, exactly, and done only after a yes; it is checked against the file as it was shown; and it can be undone while nothing else has changed that file.

## What the lead gets

⚙ Settings → **Connectors** (new section) and **Advanced**:

| Part                                           | In the page                                                                             | On the command line (as today)                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Connector of each app** (Codex, Claude Code) | its state, **Set up** or **Repair**, **New token**, **Undo**                            | `npm run setup`, `--rotate`                                                    |
| **How setup works** (`connectors.install`)     | user (edits the apps' files) or manual (writes the entries to `~/.konfab/app-setup.md`) | `npm run config -- set connectors.install manual`, `npm run setup -- --manual` |
| **Codex posts without asking**                 | a switch, with its question                                                             | `--allow-room-posts`, `--ask-before-room-posts`                                |
| **Start at login** (macOS)                     | its state, **Turn on**, **Turn off**                                                    | `npm run login-item -- install`, `uninstall`                                   |
| An old project connector                       | not in the page (see "Left out")                                                        | `--migrate <folder>`                                                           |

## Connector state

For each app the page shows one line, computed without writing anything:

| State                     | Means                                                                                                                 | Offered                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Connected**             | the app's file has Konfab's entry, its token is this Konfab's, and its address and Node path are those of this server | **New token**                         |
| **Set up, other address** | the entry points to another port or Node path (after a port change or a Node update)                                  | **Repair**                            |
| **Token not known**       | an entry is there, but its token isn't this Konfab's (another Konfab folder, or an old token)                         | **Repair** (makes a new one)          |
| **Not set up**            | the app is installed, its file has no entry                                                                           | **Set up**                            |
| **App not found**         | no `~/.codex` or no Claude Code file                                                                                  | the text of today: start the app once |
| **Manual**                | `connectors.install` is manual                                                                                        | where the entries are written         |

The token itself is never in the page or an answer, as today.

## Every change: preview, yes, apply, undo

1. **Preview.** The server computes what setup would write, with the same code as `npm run setup`, but writes nothing. The page shows, per file: its path; what is added, changed or left (for example "adds `[mcp_servers.konfab]`", "changes `KONFAB_URL` from :8787 to :9000"); where the backup will go; and that the app must be restarted to use it. A token change is described ("a new token"), never shown.
2. **Yes.** The page sends the hash of each file as it was previewed.
3. **Apply.** The existing journal and safe writing do the work (`replaceConfig`: a backup, an atomic replace, and a check that the file is still what was read). If a file's hash isn't the previewed one, **nothing** is written and the page shows the new preview. Tokens are stored as today, in the same transaction as before.
4. **Undo.** The last change Konfab made to a file can be undone from the page while that file is still byte for byte what Konfab wrote; then the backup is put back. If the file changed since, the page says so and shows the backup's path instead. A token that was replaced stays replaced (the old one isn't brought back): **Undo** of a **New token** is therefore not offered.

Interrupted at any point, the journal of today recovers at the next setup or start, as now.

## Codex posts without asking

Codex's own approval for Konfab's `post_message` only, as `--allow-room-posts` does today: Konfab counts the value as its own only while Codex's whole file is still what Konfab wrote. The page shows the state in the words of today (`describeRoomPosts`), and:

- **On** asks: "Codex agents then post in rooms without asking you each time. Their other actions, the app's reviewer and Konfab's permission requests stay as they are. Codex needs a restart. Turn it on?"
- **Off** asks nothing more than "Codex asks you again before each post. Turn it off?"
- If Codex has its own value, or the file was changed by someone else, the switch is off and the page says why, as setup does.
- Claude Code: not offered, as today (its rule isn't verified).

## Start at login (macOS)

- **State:** on, off, or "set up by an earlier version" (as `npm run doctor` says).
- **Turn on** writes the LaunchAgent and asks first: "Konfab then starts when you log in, with this folder and this Node. It isn't started now, because it is already running." Unlike the command, the page **doesn't start it now** (the port is in use by this very server).
- **Turn off** removes the LaunchAgent and asks first. It **doesn't stop** the Konfab that is running, even if launchd started it: "Konfab keeps running until you quit it, and doesn't start at the next login."
- **Other systems:** the row says "Not available here; start Konfab with your own service manager", as `doctor` does.

## Safety

- All routes need this page's own Origin and the lead's sign-in, as phases 1 to 3; agents have no route to them.
- Every write is to a path that Konfab computes (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `~/Library/LaunchAgents`), never one from the request.
- What remains, as before: a program that runs as the lead, including an agent that runs commands, can write these files itself.

## Left out

- **Migrating an old project connector** (`--migrate <folder>`) stays on the command line: it takes a folder path, was needed once for an old version, and the page would have to accept a path to any folder. The guide says so.
- **Start at login on Linux** (a systemd user unit): not today, in either way. A question for the lead.
- **The first setup and sign-in:** the terminal, by nature.

## Tests

- State: each row of the table from real files in a temporary `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.
- Preview writes nothing; apply writes exactly the preview; a file changed between preview and apply is refused, and nothing is written to the other one; interrupted after each step, the journal recovers.
- Undo puts the backup back only while the file is what Konfab wrote; otherwise it refuses and names the backup.
- No token in any answer or log (a marked token).
- Codex posts: the cases of `room-posts` today, through the page.
- Start at login: a stand-in for `launchctl` and a temporary home; on, off, earlier version; never started or stopped from the page.
- Agents, other origins, and a request with a path: refused.

## Questions for the lead

| #   | Question                                                                                           | I recommend                       |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | **Undo** of the last connector change in the page, while the app's file is unchanged since?        | yes                               |
| 2   | **Start at login** from the page only for the next login, without starting or stopping Konfab now? | yes                               |
| 3   | Moving an old project connector stays on the command line only?                                    | yes                               |
| 4   | Start at login on **Linux** (a systemd user unit), later?                                          | later, if you use Konfab on Linux |
