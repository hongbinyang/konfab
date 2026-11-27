# Settings, phase 4: connectors, Codex posts and start at login

**Status:** built. The connectors of both apps, Codex posts without asking, adding or removing an app, and start at login, after the launchd trial with the lead on 2026-11-26 (results below). The lead agreed to all six recommendations (2026-11-26).

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

### Preview

The server computes the change with the same code as `npm run setup` and writes nothing. It keeps the preview for 10 minutes under a random number, with everything it is bound to:

- the operation (set up, repair, new token, posts on or off, start at login on or off) and the apps it touches;
- each target path, as this server computes it from `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and the home folder (never a path from the request), and for each file: absent or present, its identity (device, inode), owner, mode, hash and whether it is a link;
- the server state it was made for: the port and address, the Node and bridge paths, and each app's token state (which token hash is in use).

The page shows, per file: its path; what is added, changed or left ("adds `[mcp_servers.konfab]`", "changes `KONFAB_URL` from :8787 to :9000"); and that the app must be restarted. A token is described ("a new token"), never shown. **A link** as a target is refused in the preview, as setup does with `config.yaml`.

### Apply

The page sends the preview's number and the lead's yes. Then, **in Konfab's settings lock** (the one of phases 1 to 3, also taken by `npm run setup` from now on):

1. Everything the preview is bound to is checked again: operation, paths, file identities and hashes, server state. **Any difference: nothing is written**, and the page gets a new preview.
2. The journal is written (as today: the files' contents before and after, and the token hashes; private, in Konfab's folder).
3. Each file is replaced in turn (`replaceConfig`): a backup with a random name, made new (never over another), a temporary file, a last check that the file is still what was read, then a rename. The token store is in the same database transaction.
4. The journal is removed.

**What this does and doesn't promise**, said in the guide too:

| Happens                                                                               | Outcome                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A file differs at step 1                                                              | nothing written                                                                                                                                                                         |
| The second file changed between step 1 and its last check (an app or editor wrote it) | the first file is put back from its backup if it is still what Konfab wrote; tokens unchanged. The page says exactly that, file by file                                                 |
| The first file was changed by someone else before it could be put back                | it is left as it is, the journal stays, and the page names the file and its backup: **partial**, said so                                                                                |
| Konfab or the computer stops between steps                                            | the journal recovers at the next setup or start, as today                                                                                                                               |
| An app or editor writes a file **between the last check and the rename** (a moment)   | its write is lost; the backup has the state before Konfab's. This can't be prevented for files that other programs write without a lock, and is said in the guide, as for `config.yaml` |

Claude Code writes `.claude.json` often while it runs. So a **set up or repair of Claude Code** says first: "Best done while Claude Code is closed."

### Undo

Each applied change is recorded: per file, the path, identity and hash **right after Konfab's write**, the backup's name, and the server state the change was for. **Undo** of the last change:

- **only while** each file is still byte for byte what Konfab wrote (same identity and hash), and **only if** the state it would bring back still works with this server: the token in the backup is one this Konfab accepts now, and its address is this server's. A change since (a new token, another port, a repair) makes the backup's connector stale.
- If that isn't so, Undo isn't offered for that file; the page says why ("the earlier entry has a token that was replaced since; it wouldn't connect") and names the backup's path, **never its contents**, which hold a token.
- Undo is itself a change: preview, yes, apply, under the same rules.

## Codex posts without asking

Codex's own approval for Konfab's `post_message` only, as `--allow-room-posts` does today: Konfab counts the value as its own only while Codex's whole file is still what Konfab wrote. The page shows the state in the words of today (`describeRoomPosts`), and:

- **On** asks: "Codex agents then post in rooms without asking you each time. Their other actions, the app's reviewer and Konfab's permission requests stay as they are. Codex needs a restart. Turn it on?"
- **Off** asks nothing more than "Codex asks you again before each post. Turn it off?"
- If Codex has its own value, or the file was changed by someone else, the switch is off and the page says why, as setup does.
- Claude Code: not offered, as today (its rule isn't verified).

## Start at login (macOS)

The LaunchAgent has `RunAtLoad` and `KeepAlive` with `SuccessfulExit` false: launchd starts Konfab at login, and again if it **crashes**; a normal quit isn't followed by a new start. So what "turn on" and "turn off" do depends on whether the job is **loaded** now, which the page looks at with `launchctl print gui/<uid>/<label>` (read only).

| Now                                         | Turn on                                                                                     | Turn off                                                                                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| not loaded, no file                         | writes the file; **not** loaded now (this server holds the port). Started at the next login | —                                                                                                                                                                                                                                                   |
| loaded (this server was started by launchd) | writes the file anew; the loaded job keeps its old definition until the next login          | removes the file. The loaded job stays loaded until logout: Konfab keeps running, and would be started again only after a crash. The question says so. It also offers `launchctl bootout` to unload it now, which **ends this server and the page** |
| file of an earlier version                  | as turn on: replaced                                                                        | as turn off                                                                                                                                                                                                                                         |

**The trial (2026-11-26, with the lead, a throwaway job running `/bin/sleep`):** a file alone wasn't loaded; a file changed while loaded left the loaded definition as it was; a file removed while loaded left the job loaded and running; after `kill -9` launchd started it again; `bootout` unloaded it and ended the process, which wasn't started again. The next login itself wasn't tried (it needs a log-out); it rests on launchd loading `~/Library/LaunchAgents` at login. Built accordingly: the page writes or removes only the file, and unloads only by the lead's own choice, after its answer is sent.

Other systems: "Not available here; start Konfab with your own service manager", as `npm run doctor` says.

## Safety

- All routes need this page's own Origin and the lead's sign-in, as phases 1 to 3; agents have no route to them.
- Every write is to a path that Konfab computes (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `~/Library/LaunchAgents`), never one from the request.
- What remains, as before: a program that runs as the lead, including an agent that runs commands, can write these files itself.

## Left out: decisions for the lead

Full parity of the page and the command line isn't reached with these three exceptions; each is the lead's choice.

| Exception                                                      | Why left out                                                                                                  | If wanted                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Moving an old project connector** (`--migrate <folder>`)     | it needs a folder path from the page, and was for an upgrade long ago                                         | a page field for the folder, with a preview of exactly that project's file                                                                                 |
| **Adding or removing an app in `config.yaml`** (`agents.<id>`) | Konfab has connectors for exactly two apps, Codex and Claude Code; an entry is useful only with its connector | per app: **Add to Konfab** or **Remove from Konfab**, next to its connector. Remove keeps its agents' history and asks whether to remove the connector too |
| **Start at login on Linux** (a systemd user unit)              | not built in either way                                                                                       | later, if Konfab is used on Linux                                                                                                                          |

The **first setup and sign-in** stay in the terminal by nature: the page can't be reached before.

## Tests

- State: each row of the table from real files in a temporary `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.
- Preview writes nothing, and binds what it says: a changed operation, path (another `CODEX_HOME`), identity (a file replaced by another), hash, link, absent file, server state (another port, a new token) each make apply refuse and write nothing.
- Apply: exactly the preview; a writer at each point (before the lock, between the two files, at the last check) gives the outcome of the table; a stop after each step is recovered by the journal; backup names never collide.
- Undo: refused after a rotation, a repair, a port change, a migration, or a later edit of the file; allowed and exact otherwise.
- No token in any answer, log or page, also not from a backup or the journal (a marked token).
- Codex posts: the cases of `room-posts` today, through the page.
- Start at login: a stand-in for `launchctl` with loaded and not loaded jobs; the real behaviour only from the trial above.
- Agents, other origins, a request with a path: refused.

## For later

Documented so that they can be picked up; none is built.

| Item                                        | State                            | What it needs                                                                                                    |
| ------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Start at login in the page                  | designed above                   | the launchd trial with the lead (a throwaway job; Konfab's own untouched), then build it to what the trial shows |
| Moving an old project connector in the page | the lead chose command line only | nothing, unless asked again                                                                                      |
| Start at login on Linux                     | the lead chose later             | a systemd user unit, in both ways, with its own trial                                                            |
| A room's own settings on the command line   | the lead chose to skip (phase 3) | a command line that goes through the running server                                                              |
| Claude Code posting without asking          | its rule isn't verified          | a trial of Claude Code's per-tool approval for Konfab                                                            |
| Real end-to-end tries                       | stand-ins only                   | a real Telegram bot, a real GitHub token, Linux x86-64                                                           |

## Questions for the lead

| #   | Question                                                                                                                   | I recommend                  |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | **Undo** of the last connector change, only while the file is unchanged and the earlier entry would still connect?         | yes                          |
| 2   | Start at login from the page: **next login only**, and stopping the running Konfab only by its own choice in the question? | yes                          |
| 3   | The **trial** with a throwaway launchd job before building start at login, with you at the computer?                       | yes; no windows are expected |
| 4   | **Moving an old project connector:** in the page too, or command line only?                                                | command line only            |
| 5   | **Adding or removing Codex or Claude Code in `config.yaml`** from the page?                                                | yes, next to the connector   |
| 6   | Start at login on **Linux**: later?                                                                                        | later                        |
