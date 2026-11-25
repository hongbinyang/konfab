# Settings in the page and on the command line

**Status:** proposal for discussion. Nothing is built. The lead asked for it on 2026-11-25: "configs should be supported by both commandline and UI", for example turning on Rejoin for Claude agents and phone notices; `npm run setup` stays.

## Today: every setting and every action of setup

| What                                                | Kept in                                   | Command line today                              | Page today     | In use after             |
| --------------------------------------------------- | ----------------------------------------- | ----------------------------------------------- | -------------- | ------------------------ |
| `phone_notices.*` (6)                               | `config.yaml`                             | edit the file                                   | no             | restart                  |
| Phone notices on or off                             | `telegram.json`                           | at setup only                                   | yes            | at once                  |
| Phone notices: bot, chat, test, remove              | `telegram.json`, Keychain or environment  | `setup -- --telegram` (`--remove`)              | no             | at once                  |
| `rejoin.*` (6)                                      | `config.yaml`                             | edit the file                                   | no             | restart                  |
| `defaults.*` (12 in use), `multi_agent.max_per_app` | `config.yaml`                             | edit the file                                   | no             | restart                  |
| `agents.*.run_hours`                                | `config.yaml`                             | edit the file                                   | no             | restart                  |
| Which agents there are, their names                 | database (`agents` in the file only adds) | edit the file                                   | yes            | at once                  |
| A room's own settings                               | database                                  | no                                              | yes (**Edit**) | at once                  |
| `pre_approvals`                                     | `config.yaml`                             | edit the file                                   | shown          | restart                  |
| `server.port`, `server.tick_seconds`                | `config.yaml`                             | edit the file                                   | no             | restart                  |
| `connectors.install`                                | `config.yaml`                             | edit the file; `--manual`                       | no             | next setup               |
| Connectors of both apps, new tokens                 | the apps' own files, database             | `setup`, `--manual`, `--rotate`, `--migrate`    | no             | restart of the connector |
| Codex posts without asking                          | Codex's own file                          | `--allow-room-posts`, `--ask-before-room-posts` | no             | restart of the connector |
| GitHub token                                        | Keychain or environment                   | `--github-token` (`--remove`)                   | no             | restart                  |
| Start at login                                      | a macOS file                              | `login-item -- install`, `uninstall`            | no             | next login               |
| `defaults.hours`, `agents.*.hours`                  | `config.yaml`                             | nothing reads them                              | no             | never                    |

A room's own settings on the command line: an **open question** (decision 6); not in the phases below.

## Principles

1. **The same stores and the same rules for every door.** The page and the command line read and write the same places as today (the file, `telegram.json`, the Keychain, the database, the apps' own files), through the same code. No second copy is made. They can still differ from what is in use until a restart or a join, and both say so.
2. **One description of each setting.** Its name, help, limits, default, and when it takes effect are written once, in one list. The page, the command line, the check of the file and the table in the user guide come from it. A test fails if a setting is missing in one of them.
3. **It works at once where it can,** and the page says when it can't: "at the next join", "after a restart".
4. **Secrets** never go into `config.yaml`, a log, a message, a backup or an answer. They stay in the Keychain (or the environment, where there is none).
5. **`npm run setup` stays** and does what it does.
6. **Elegant:** one Settings page, short rows, plain words. Nobody needs it to start.

## What the lead sees

**⚙ Settings** in the left sidebar, beside **Manage library**. Sections: **Phone notices**, **Rejoin**, **Agents and turns**, **Skills**, **Advanced**.

- A row: name, one line of help, its control, and only if it isn't at once, when it takes effect. A changed one has **Reset** (with its default).
- A switch is saved by its click. Numbers and times are saved by **Save**, which appears when something has changed, beside **Discard**. A wrong value is said beside its field, and nothing is saved.
- Where something isn't set up, its place says so with a button that leads there: **Set up…** under **Lead** for phone notices; **Turn on Rejoin for Claude…** on an agent's card.
- A room's own value stays in the room's **Edit**; it says "Default (2 min)", as now, with a link to the default.

### On the command line

```
npm run config                                  # all settings, values, defaults
npm run config -- get rejoin.claude_watcher
npm run config -- set rejoin.claude_watcher true
npm run config -- reset phone_notices.away_minutes
```

It says the same as the page: what changed, and when it takes effect. It works with the server on or off. `npm run setup -- --telegram` (also with `--remove`) and `--github-token` stay.

What the page has and the command line hasn't yet is added: `npm run setup -- --telegram --status`, `--on`, `--off` and `--test`.

## Each setting

"At once" was checked against the code: who holds the value, and when it is read.

| Setting                                                                                                                                                          | Held by                                               | In use after a change                                                                              | Page                  | Phase |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------- | ----- |
| `phone_notices.*`                                                                                                                                                | notices, read at every pass                           | the next pass. A notice being sent is finished as it was                                           | yes                   | 1     |
| `rejoin.enabled`, `open_apps`                                                                                                                                    | copies at the start; the sending command              | at once, after a change of the code. Off closes the open requests of its kind                      | yes                   | 1     |
| `rejoin.wanted_minutes`                                                                                                                                          | read for each request                                 | new requests; open ones keep their end                                                             | yes                   | 1     |
| `rejoin.claude_watcher`                                                                                                                                          | flag and callback set at the start                    | see below                                                                                          | yes                   | 1     |
| `rejoin.allow_untested_version`, `codex_command`                                                                                                                 | the check of the command, at the start and by a timer | checked at once; a command that runs is finished                                                   | with a question       | 1     |
| Bot, chat, test, on, off, remove                                                                                                                                 | notices, read at every pass                           | at once                                                                                            | yes                   | 2     |
| `checkin_minutes`, `max_consecutive_agent_messages`, `max_parallel_lead_turns`, `turn_timeout_minutes`, `max_message_chars`, `max_decision_chars`, `max_per_app` | read when used                                        | at once. A shorter `turn_timeout_minutes` can end a silent turn at the next look, so it asks first | yes                   | 3     |
| `auto_continue_delay_seconds`                                                                                                                                    | stored with each continuation                         | the next one                                                                                       | yes                   | 3     |
| `wait_timeout_seconds`                                                                                                                                           | read at each wait; told to the connector at a join    | the next wait; the told number at the next join                                                    | yes                   | 3     |
| `run_hours`, `agents.*.run_hours`                                                                                                                                | read at a join                                        | the next join                                                                                      | yes                   | 3     |
| `run_warnings_minutes`                                                                                                                                           | read at a join and while it runs                      | at once for what hasn't been warned yet                                                            | yes                   | 3     |
| `parallel_lead_mentions`                                                                                                                                         | read for a new room                                   | new rooms                                                                                          | yes                   | 3     |
| `max_attachment_mb`                                                                                                                                              | the limit of a route, fixed at the start              | restart                                                                                            | yes                   | 3     |
| `pre_approvals`                                                                                                                                                  | read at each request                                  | at once; what is approved already stays                                                            | a question for each   | 3     |
| `server.tick_seconds`                                                                                                                                            | a timer, set at the start                             | restart                                                                                            | yes                   | 3     |
| `server.port`                                                                                                                                                    | listening, the sign-in link, the watchers' files      | restart, then setup for both apps                                                                  | with a question       | 3     |
| GitHub token                                                                                                                                                     | given to the skill search at the start                | restart, unless the code is changed for it                                                         | yes                   | 3     |
| `connectors.install`                                                                                                                                             | setup                                                 | the next setup                                                                                     | yes                   | 4     |
| Connectors, Codex posts without asking, start at login                                                                                                           | other programs' files                                 | restart of the connector; next login                                                               | yes                   | 4     |
| `hours`                                                                                                                                                          | nothing                                               | never                                                                                              | no; said to be unused |       |

**Parity is reached with phase 4, not before.** The page and the guide say for each phase what is there.

### Two settings that need care

Neither is left out; each has its own steps.

**`server.port`.** Saving it changes only what the next start uses; the page goes on working until then. Before: the number is checked and whether something else listens there now. The question says: "Used after the next restart. The page is then at http://127.0.0.1:9000, and both apps need `npm run setup` once; until then their agents can't reach Konfab." If that port is taken at the start, Konfab says which setting it is and how to put it back. Way back without the server: `npm run config -- reset server.port`.

**`rejoin.codex_command`.** It names a program that Konfab runs as the user. Before anything is run, what can be seen without running it: an absolute path, an ordinary file, its and its folders' owner and rights, not inside Konfab's own folder (where attachments are), and who signed it. The question shows the real path and the signature ("not signed by OpenAI") and says what it means. Only after the yes its version is asked. **Nothing runs it before:** not the check, not a refresh, not a look at the file that was edited by hand. The yes is for that one file (its real path and identity, kept in `~/.konfab/codex-command.json`); if the setting names another, or the file has changed, the button is off and the page asks again. Its identity is looked at once more right before each run. A command that was set before this version is taken as agreed once, at the first start. The signature is something to go by, not a guarantee. Way back: **Reset**, or the command line. **What remains:** who controls the lead's page could choose a program of that user. That is why the question is its own step and can't be reached by a link; a fresh sign-in code can be asked for as well (decision 2).

### Where values come from, and which one counts

| Kind                                       | Kept in                              | Counts                                                                                               |
| ------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Settings                                   | `config.yaml`                        | an option of the command (such as `--manual`, for that run only), then the file, then the default    |
| A room's own (check-in, parallel mentions) | database, as now                     | the room's, then the default. `parallel_lead_mentions` is only for new rooms, as now                 |
| Run hours                                  | `config.yaml`                        | the agent's, then its app's, then the default, as now                                                |
| Phone notices: chat, on or off             | `telegram.json`, as now              | that file. It belongs to one setup and one token, so it stays apart from the options                 |
| Tokens                                     | Keychain, or an environment variable | as now: for phone notices the place that the setup names; for GitHub the variable, then the Keychain |
| Folders                                    | environment variables only           | not settings; **Advanced** shows them                                                                |

**Saved and in use** are two things, and both are shown when they differ: "Saved: 9000. In use: 8787 until Konfab restarts." A row never shows only the saved one. The running server keeps a private note in Konfab's folder: which version of the file it uses, since when, and the values that differ. The command line reads it and waits a few seconds for it. "In use.", or "Saved. Konfab isn't running; used at the next start.", or, if the note isn't fresh or the server doesn't follow: "Saved. The running Konfab hasn't confirmed it." It belongs to this folder, so a Konfab with another folder or port isn't taken for this one. After a broken file: "In use: the values from before. The file has an error in line 12."

A token from the environment is shown as "From KONFAB_GITHUB_TOKEN, which comes first. The one in the Keychain isn't used." It can be stored all the same, and the answer says that it isn't in use; the page and the command line never change the environment.

### Existing installations

- The file's form doesn't change and nothing is moved. A file without a setting has its default, as now; the page adds a key only when it is changed, and **Reset** removes it.
- Unknown keys stay (an older file can have `room` or `ui`, which nothing reads any more). Going back to an older Konfab works: it ignores keys it doesn't know.
- A phone setup made in the terminal is shown and can be used, tested, replaced or removed in the page, and the other way round.

### Interrupted

| At                                | Then                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Saving, before the rename         | the old file, whole; the temporary one is removed at the next start                |
| Saving, after the rename          | the new file, whole; read within 2 seconds, or at the next start                   |
| Phone setup, before the last step | the earlier setup works; the new token is removed, at the latest at the next start |
| Phone setup, after the last step  | the new setup works; the earlier token is removed, at the latest at the next start |
| Removing phone notices            | off first, then the token; if that fails it is said and can be tried again         |

## How it works

**The list.** `src/server/settings.ts`: for each setting its path, type and limits (the existing zod schema), section, name, help, default, `effect` (`now`, `next_join`, `restart`), and `page` (`edit`, `ask`, `later`). `config.ts` uses it.

**Reading.** The server keeps the last good configuration and looks about every 2 seconds whether the file has changed (time, size, inode), so an edit by hand or by the command line takes effect the same way. That is a target: a busy server is later, and a file system that doesn't show a change in these is seen at the next save or start. A file that is broken or doesn't fit is not used: the last good one stays, the page says what is wrong in which line, and its controls are off until it is right. At a start with such a file it is as today: Konfab says why and doesn't start.

**Using it.** Parts of the server get a way to read the current value instead of a copy at the start. A setting counts as "at once" only with a test that changes it in a running server.

**Writing.** One function for the page and the command line:

1. Take the lock: an immediate transaction on a small SQLite file beside the configuration, with a limit of 5 seconds. The system ends it with the process, so there is nothing stale to recover. Setup takes the same lock.
2. Open the file without following a link; it must be an ordinary file of this user with one name, in Konfab's own private folder. Read it, and compare its hash with the one that was shown.
3. Change only the named keys, and check the whole. Unknown keys and comments stay. (A trial with the YAML library kept them, but a comment at the very end can end up after a new key: a new section goes before it, with tests on real files.)
4. Write a new private file (`0600`, must not exist), bring it to the disk, look at the hash and the file's identity once more, and rename it. A rename replaces a link that was put there meanwhile; it never writes through it.
5. The earlier file is kept first: the last 5, `0600`, in `~/.konfab/backups/config/`. They are for the lead to look at; nothing puts them back by itself.

If the hash differs: "The file has changed. Here are the values now." Nothing is written.

**What this doesn't protect:** an editor takes no lock. If it saves between the last look and the rename (well under a second), **its save is lost, and it may be in no earlier file**: what was kept is what Konfab had read before. The other way round, an editor that has the old text open overwrites a change of the page with its next save, if it doesn't notice that the file changed. Both are in the guide ("don't edit the file while you save in the page"). Both orders are tested with a stand-in editor, and the tests state which of the two versions is left, not that none is lost.

**Routes.** `GET /api/settings`, `PATCH /api/settings` (the hash, and at most the known keys that the page may change; anything else is refused), `POST /api/settings/reset`. They need the page's session cookie, as all of `/api/` does (an agent's token is refused there: tested for each route). Today a request without an Origin header is let through, since the cookie isn't sent from other sites; these routes ask for this page's own Origin in addition. **An agent that can run commands as the user can make itself a sign-in link or edit the file;** no route can prevent that, and the guide says so. A change is in the activity as "settings changed: rejoin.claude_watcher", with the name, not the value.

**Environment.** A value that an environment variable overrides is shown as that, and is off.

## Phone notices in the page

The setup's questions and checks become one engine with steps, used by both the command line and the page. The page shows one step at a time:

| Step    | The lead does                                                                       | Konfab does                                                                                   |
| ------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1 Bot   | makes a bot with @BotFather, pastes the token, agrees that Konfab contacts Telegram | stores the token in the **free** Keychain place, checks the bot and that nothing else uses it |
| 2 Chat  | sends the shown code to the bot from the phone                                      | waits up to 5 minutes for exactly this code, after it was shown                               |
| 3 Check | reads whose chat it is, selects **Send a test**, says whether it came               | sends "Konfab: test"                                                                          |
| 4 On    | selects **Turn on**                                                                 | writes the new setup in one step                                                              |

- **The earlier setup stays** and goes on working until step 4. Cancel, closing the page, 15 minutes, a failure or a restart of Konfab end it and remove the new token; a left-over is removed at the next start.
- **One at a time.** Setting up, turning on or off, and removing take the same lock (as above) for each change, and a setup keeps the number of the setup it began with. If a removal or another setup came in between, its last step is refused and its token removed; it never brings back what was removed. A token that is in use by `telegram.json` is never removed as a left-over.
- Later: **Send a test**, **Set up again**, **Remove** (with a question).
- On other systems than macOS the token still comes from `KONFAB_TELEGRAM_TOKEN`; the page says how, and does the rest.

### The token

It goes once from the page to Konfab on `127.0.0.1`, and from there to the Keychain. The terminal way has no such step, so this is a trade, and the guide says so.

- A password field that isn't kept, filled in or suggested; emptied with the click. Never in a URL, in the page's stored data or in any answer. No answer ever contains it, not even a part.
- A route of its own: the signed-in lead and this page only, a small limit, JSON only, and excluded from request logs, stored replies, activity, errors and backups. A test searches all of these for a marked token.
- **To the Keychain without the process list:** `security -i` takes its command from its input. Tried on 2026-11-25 on macOS with a made-up token and a keychain of its own:

  | Tried                                           | Seen                                                                       |
  | ----------------------------------------------- | -------------------------------------------------------------------------- |
  | store, and replace                              | read back equal; nothing printed                                           |
  | the process list, 11 looks while it ran         | the token wasn't in it                                                     |
  | a wrong option                                  | refused with code 2; the token wasn't printed, the stored one unchanged    |
  | a **locked** keychain, and one that isn't there | **it waits, with a password window of macOS.** Ended after 4 and 8 seconds |

  So: the accepted form of a token (digits, a colon, letters, digits, `-`, `_`) and the fixed names have nothing to quote, and anything else is refused before. The lead is told that macOS may ask for the keychain's password. A limit of 60 seconds ends it; then it is read once to see what is stored. If that stays unknown, nothing is committed, the earlier setup stays, and the page says that the clean-up is uncertain. A place that a committed setup names is never removed, whatever the result was. Not tried yet: a refused password window, an item that another program made, ending it in the middle of a replacement, other macOS versions. These come before phase 2 is built, with the lead at the computer because of the windows. If one fails, the token stays in the terminal, and the page does steps 2 to 4.

- **What it doesn't protect against:** other programs of the same user (as today: they may be able to read the item, Konfab's memory or the page's session), and while it is typed, the browser and its extensions. Nothing in the page or the guide may say more.

## Rejoin for Claude agents in the page

The switch says what it does before it is turned on: "Asks Claude agents, when they join, to start one small background command that wakes them. Claude may ask you to allow it."

What the code does today when it is off at a start, and what is planned for turning it off in a running server:

| A watcher that           | Today, off at a start                                                                                                                                               | Turned off while running                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| was offered, not started | its ticket is void; it ends by itself                                                                                                                               | the same, at once                                                                                                                               |
| waits (armed)            | marked as ended; from its next call on it rests. It is never given a request                                                                                        | the same; its open call is answered at once, and a request being sent at that moment is either given before or refused: one transaction decides |
| has been given a request | prints it: that can't be taken back                                                                                                                                 | the same, but the **request is closed**, so the agent that wakes is told "closed" and ends its turn. That short turn can happen                 |
| rests                    | stays until Claude is closed. Konfab may tell it to end while its agent is waiting (at most twice a day); **its end can start a short notice in that conversation** | the same; with the switch off this stops as well, so that nothing is woken by Konfab                                                            |

Turned on again: a watcher that was ended stays so. **Each Claude agent needs one join**, and the page says so: paste the rejoin prompt once, since Rejoin needs a watcher that isn't there yet. Also the first time: a session that joined while it was off has no conversation stored.

Open requests when `rejoin.enabled` goes off: closed, with the reason "turned off"; a prompt in Codex's queue may still come and is told "closed". Sending that has begun is finished and then shown as closed.

## Decisions for the lead

1. **The token in the page (phase 2)?** Recommended, after the remaining Keychain trials; the terminal way stays.
2. **`rejoin.codex_command` in the page:** with its own question (recommended), and in addition a fresh sign-in code from the terminal (safer, less convenient)?
3. **`pre_approvals` in the page,** each with a question that names what it allows? Recommended, in phase 3.
4. **The look** (mock-up).
5. **Connectors, Codex posts without asking, and start at login (phase 4):** they change other programs' files. Recommended as buttons that run exactly what the command does, after showing what would change. The first setup stays in the terminal: without it and the sign-in link there is no page yet.
6. **A room's own settings** (brief, check-in, parallel mentions) on the command line too?

## Phases

| Phase | Page                                                       | Command line                                           | Then still only elsewhere              |
| ----- | ---------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- |
| 1     | Rejoin (6), options of phone notices (6)                   | `npm run config` for **all** settings in `config.yaml` | the rest                               |
| 2     | phone notices: set up, test, on, off, set up again, remove | `--telegram --status`, `--on`, `--off`, `--test`       | phase 3 and 4                          |
| 3     | all other settings in `config.yaml`, GitHub token          | `--github-token --status`                              | phase 4                                |
| 4     | connectors, Codex posts without asking, start at login     | as today                                               | the first setup and sign-in (terminal) |

**Other systems:** Rejoin, opening apps, the Keychain and start at login are macOS only; there their rows say so and are off. Tokens come from the environment there, and the page says how. Everything else is the same.

README, user guide and REQUIREMENTS change with each phase, and only for what that phase ships: **Configuration** starts with the page, then the command line, then the file; its table is made from the list; phone notices and Rejoin for Claude start with the page and keep the command line. REQUIREMENTS gets a section.

## Tests

- **One list:** every key of the schema is in the list, on the page or named as an exception, on the command line, and in the guide's table.
- **The file:** comments, order, unknown keys, odd but right YAML (anchors, quotes, Windows line ends, empty file, no file); broken YAML; a link, a folder, another owner, read-only, a full disk; a crash before and after the rename; two processes at the same moment; a process that dies with the lock; changed by hand between showing and saving.
- **The command line's report:** no server, one that hangs, one with another folder or port, a stale note, a broken file.
- **Saved and in use:** shown apart whenever they differ; after a restart they agree.
- **Existing installations:** files from earlier versions, with none of the new keys and with unknown ones; a phone setup from the terminal; going back to the earlier version.
- **Effect:** for each "at once", changed in a running server and seen in what it does; for the others, the page says when.
- **Equal:** the same change by page, command line and by hand gives the same file values and effect.
- **Live changes:** for each row above, in a running server: before, in the middle of (a notice, a request, a watcher's call, a turn, a wait) and after; then a restart, and a broken file put in between.
- **Routes:** lead only; an agent's token and a watcher's ticket refused at each; without and with a foreign Origin; unknown, shown-only and wrong values refused, nothing written.
- **Keychain:** the command's input and limits against a stand-in; locked, refused, ended in the middle, a wrong answer; a setup, a removal and a second setup crossed in every order.
- **Phone setup:** each step and each way out, in the page and on the command line, also crossed; the earlier setup untouched until the end; a stand-in for Telegram and the Keychain, never the real ones; the marked token in no log, database, backup, answer, page or process list.
- **Watcher switch:** on and off with a watcher there, a request open, an agent in a turn.
- Keyboard, reading aloud, both themes, 375 px.

## Not included

Changing anything in other programs' files beyond what the setup commands do, several users, settings in the database, sharing settings between computers.
