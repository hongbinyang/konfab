# Settings in the page and on the command line

**Status:** proposal for discussion. Nothing is built. The lead asked for it on 2026-11-25: "configs should be supported by both commandline and UI", for example turning on Rejoin for Claude agents and phone notices; `npm run setup` stays.

## Today

| What                                                         | Where it can be changed           | Effect                  |
| ------------------------------------------------------------ | --------------------------------- | ----------------------- |
| A room's brief, folder, parallel mentions, check-in interval | the room's **Edit**               | at once                 |
| Phone notices on or off                                      | page, after setup                 | at once                 |
| Phone notices: bot, chat, test                               | `npm run setup -- --telegram`     | at once                 |
| Phone notices: minutes, quiet hours, limits                  | `config.yaml`                     | after a restart         |
| Rejoin: everything                                           | `config.yaml`                     | after a restart         |
| About 20 other settings                                      | `config.yaml`                     | after a restart         |
| GitHub token for skill search                                | `npm run setup -- --github-token` | after a restart         |
| Connectors of the apps                                       | `npm run setup`                   | after the app's restart |

So there are three ways, with three rules, and the command line can't change most settings either: it means editing a file by hand.

## Principles

1. **One place, three doors.** `config.yaml` stays the only store of these settings. The page, the command line and a text editor change the same file. Nothing is copied into the database, so they can't disagree.
2. **One description of each setting.** Its name, help, limits, default, and when it takes effect are written once, in one list. The page, the command line, the check of the file and the table in the user guide come from it. A test fails if a setting is missing in one of them.
3. **It works at once where it can,** and the page says when it can't: "at the next join", "after a restart".
4. **Secrets never go into the file,** the page's state, a log, a message or an agent's reach. They stay in the Keychain.
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

| Setting                                                  | Page                                                            | Takes effect                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `phone_notices.*`                                        | yes                                                             | at once                                                                       |
| Bot, chat and test of phone notices                      | yes (phase 2)                                                   | at once                                                                       |
| `rejoin.enabled`, `open_apps`, `wanted_minutes`          | yes                                                             | at once (a new request)                                                       |
| `rejoin.claude_watcher`                                  | yes                                                             | at once for what is offered; an agent starts its watcher at its **next join** |
| `rejoin.allow_untested_version`                          | yes, with a question                                            | at once                                                                       |
| `rejoin.codex_command`                                   | **shown, not changed**                                          | at once                                                                       |
| `defaults.*`, `multi_agent.max_per_app`                  | yes                                                             | at once for new turns, calls, joins or files; running ones keep theirs        |
| `agents.*.run_hours`                                     | yes                                                             | next join                                                                     |
| `agents.*` (which there are, names)                      | on the cards, as now                                            | as now                                                                        |
| `defaults.hours`, `agents.*.hours`                       | no: kept for old files and unused, to be checked while building |                                                                               |
| GitHub token                                             | yes (phase 3)                                                   | at once                                                                       |
| `pre_approvals`                                          | yes, with a question for each (phase 3)                         | at once                                                                       |
| `server.tick_seconds`, `connectors.install`              | yes, under Advanced                                             | restart; next setup                                                           |
| `server.port`                                            | **shown, not changed**                                          | restart, and setup again for both apps                                        |
| Connectors of the apps (`npm run setup`), the login item | no                                                              | they change other programs' files, and are needed before there is a page      |

**Two exceptions on purpose,** shown with the command that changes them:

- **`rejoin.codex_command`** names a program that Konfab runs. A page that can set it could make Konfab run anything, if somebody got hold of the page's session.
- **`server.port`** would take the page away from under the lead, and both connectors with it.

Both can be changed on the command line and in the file.

### Where values come from, and which one counts

| Kind                                       | Kept in                              | Counts                                                                                               |
| ------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Settings                                   | `config.yaml`                        | an option of the command (such as `--manual`), then the file, then the default                       |
| A room's own (check-in, parallel mentions) | database, as now                     | the room's, then the default. `parallel_lead_mentions` is only for new rooms, as now                 |
| Run hours                                  | `config.yaml`                        | the agent's, then its app's, then the default, as now                                                |
| Phone notices: chat, on or off             | `telegram.json`, as now              | that file. It belongs to one setup and one token, so it stays apart from the options                 |
| Tokens                                     | Keychain, or an environment variable | as now: for phone notices the place that the setup names; for GitHub the variable, then the Keychain |

**Saved and in use** are two things, and both are shown when they differ: "Saved: 9000. In use: 8787 until Konfab restarts." A row never shows only the saved one. After a broken file: "In use: the values from before. The file has an error in line 12."

### Existing installations

- The file's form doesn't change and nothing is moved. A file without a setting has its default, as now; the page adds a key only when it is changed, and **Reset** removes it.
- Unknown keys stay (an older file can have `room` or `ui`, which nothing reads any more). Going back to an older Konfab works: it ignores keys it doesn't know.
- A phone setup made in the terminal is shown and can be used, tested, replaced or removed in the page, and the other way round.

### Interrupted

| At                                | Then                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Saving, before the rename         | the old file, whole; the temporary one is removed at the next start                |
| Saving, after the rename          | the new file, whole; it is read within 2 seconds, or at the next start             |
| Phone setup, before the last step | the earlier setup works; the new token is removed, at the latest at the next start |
| Phone setup, after the last step  | the new setup works; the earlier token is removed, at the latest at the next start |
| Removing phone notices            | off first, then the token; if that fails it is said and can be tried again         |

## How it works

**The list.** `src/server/settings.ts`: for each setting its path, type and limits (the existing zod schema), section, name, help, default, `effect` (`now`, `next_join`, `restart`), and `page` (`edit`, `ask`, `show`). `config.ts` uses it.

**Reading.** The server keeps the last good configuration and looks every 2 seconds whether the file has changed (time, size, inode), so an edit by hand or by the command line takes effect the same way. A file that is broken or doesn't fit is not used: the last good one stays, the page says what is wrong in which line, and its controls are off until it is right. At a start with such a file it is as today: Konfab says why and doesn't start.

**Using it.** Parts of the server get a way to read the current value instead of a copy at the start. A setting counts as "at once" only with a test that changes it in a running server.

**Writing.** One function for the page and the command line: read the file, check that it is the one that was shown (its hash comes with the request), change only the named keys, check the whole, write a private temporary file, look again, and rename it. The rest of the file, unknown keys and comments stay. A trial with the YAML library showed that comments are kept, but one at the very end can end up after a new key; a key is therefore added to its own section, and a new section before a trailing comment, with tests on real files.
The earlier file is kept as `config.yaml.before` (the last one only, as private as the file). If somebody changed it in between: "The file has changed. Here are the values now." Nothing is written over. A link, a folder or another owner's file is refused.

Two writers at the same moment: the command line and the server take the same lock file, with a limit; whoever is second sees the changed file. An editor takes no lock, so a save from one in the last moment can still be lost or win; `config.yaml.before` has the other one.

**Routes.** `GET /api/settings`, `PATCH /api/settings` (the hash, and at most the known keys that the page may change; anything else is refused), `POST /api/settings/reset`. Only the signed-in lead, on this page (cookie and origin, as for permissions). Agents have no route. A change is in the activity as "settings changed: rejoin.claude_watcher", with the name, not the value.

**Environment.** A value that an environment variable overrides is shown as that, and is off.

## Phone notices in the page

The setup's questions and checks become one engine with steps, used by both the command line and the page. The page shows one step at a time:

| Step    | The lead does                                                                       | Konfab does                                                                                   |
| ------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1 Bot   | makes a bot with @BotFather, pastes the token, agrees that Konfab contacts Telegram | stores the token in the **free** Keychain place, checks the bot and that nothing else uses it |
| 2 Chat  | sends the shown code to the bot from the phone                                      | waits up to 5 minutes for exactly this code, after it was shown                               |
| 3 Check | reads whose chat it is, selects **Send a test**, says whether it came               | sends "Konfab: test"                                                                          |
| 4 On    | selects **Turn on**                                                                 | writes the new setup in one step                                                              |

- **The earlier setup stays** and goes on working until step 4. Cancel, closing the page, 15 minutes, a failure or a restart of Konfab end it and remove the new token; a left-over is removed at the next start. One setup at a time, on the page or the command line.
- Later: **Send a test**, **Set up again**, **Remove** (with a question).
- On other systems than macOS the token still comes from `KONFAB_TELEGRAM_TOKEN`; the page says how, and does the rest.

### The token

It goes once from the page to Konfab on `127.0.0.1`, and from there to the Keychain. The terminal way has no such step, so this is a trade, and the guide says so.

- A password field that isn't kept, filled in or suggested; emptied with the click. Never in a URL, in the page's stored data or in any answer. No answer ever contains it, not even a part.
- A route of its own: the signed-in lead and this page only, a small limit, JSON only, and excluded from request logs, stored replies, activity, errors and backups. A test searches all of these for a marked token.
- **To the Keychain without the process list:** today macOS's own command asks for it in the terminal. From the server it must not be an argument, which every program of the user can read. Planned: `security -i`, which takes its command from its input; the token's form (digits, colon, letters, `-`, `_`) leaves nothing to quote. **This is to be proven** in an isolated Keychain first: not in the process list, not in the output, what happens with a locked Keychain and a refused prompt. If it can't, a small helper with the Security framework, or the token stays in the terminal and the page does steps 2 to 4.
- What it doesn't protect against, as today: programs running as the user. While it is typed, also the browser and its extensions.

## Rejoin for Claude agents in the page

The switch says what it does before it is turned on: "Asks Claude agents, when they join, to start one small background command that wakes them. Claude may ask you to allow it." On: "Takes effect at the next join: Stop agent and Rejoin, or paste the rejoin prompt once." Off: no new watchers; those that are there rest and don't wake anybody. Both are tested in a running server, with a watcher there.

## Decisions for the lead

1. **The token in the page (phase 2)?** I recommend yes, if the Keychain step is proven; the terminal way stays.
2. **The two exceptions** (`rejoin.codex_command`, `server.port`): shown, but changed on the command line? I recommend yes.
3. **`pre_approvals` in the page?** They let agents do things without asking. I recommend yes, each with a question that names what it allows, as the last phase.
4. **The look** (mock-up).

## Phases

| Phase | What                                                                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | the one list; the file read while running; safe writing; `npm run config`; the Settings page with **Rejoin** and **Phone notices** (minutes, quiet hours, limits, **Send a test**) |
| 2     | setting up phone notices in the page, after the Keychain trial                                                                                                                     |
| 3     | all other settings, the GitHub token, `pre_approvals`                                                                                                                              |

README, user guide and REQUIREMENTS change with each phase, and only for what that phase ships: **Configuration** starts with the page, then the command line, then the file; its table is made from the list; phone notices and Rejoin for Claude start with the page and keep the command line. REQUIREMENTS gets a section.

## Tests

- **One list:** every key of the schema is in the list, on the page or named as an exception, on the command line, and in the guide's table.
- **The file:** comments, order, unknown keys, odd but right YAML (anchors, quotes, Windows line ends, empty file, no file); broken YAML; a link, a folder, another owner, read-only, a full disk; a crash before and after the rename; two processes at the same moment; changed by hand between showing and saving.
- **Saved and in use:** shown apart whenever they differ; after a restart they agree.
- **Existing installations:** files from earlier versions, with none of the new keys and with unknown ones; a phone setup from the terminal; going back to the earlier version.
- **Effect:** for each "at once", changed in a running server and seen in what it does; for the others, the page says when.
- **Equal:** the same change by page, command line and by hand gives the same file values and effect.
- **Routes:** lead only; unknown, shown-only and wrong values refused, nothing written.
- **Phone setup:** each step and each way out, in the page and on the command line, also crossed; the earlier setup untouched until the end; a stand-in for Telegram and the Keychain, never the real ones; the marked token in no log, database, backup, answer, page or process list.
- **Watcher switch:** on and off with a watcher there, a request open, an agent in a turn.
- Keyboard, reading aloud, both themes, 375 px.

## Not included

Changing other programs' settings from the page, several users, settings in the database, sharing settings between computers.
