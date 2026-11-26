# Settings, phase 3: every other setting in the page

**Status:** a plan for review; nothing is built. It continues [Settings](settings.md) (phases 1 and 2 are in use) and uses what they built: one list of settings, safe writing of `config.yaml`, saved and in use, conflicts while typing, and the token places of [phone setup](settings-phone-setup.md).

## What the lead gets

| Part              | In the page (⚙ Settings)                                                                                                    | On the command line                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Agents**        | the 12 settings of `defaults` and `multi_agent`, each with its field, **Save**, **Discard**, **Reset**; run hours per agent | `npm run config` as now                                                                 |
| **Pre-approvals** | the list, **Add…** and **Remove**, each with a question that names what it allows                                           | new: `npm run config -- approve <recipient> <data>`, `unapprove …`; `get pre_approvals` |
| **GitHub token**  | state, **Set…** (pasted, as the bot's token), **Remove**                                                                    | new: `npm run setup -- --github-token --status`                                         |
| **Advanced**      | port (with its question), clock                                                                                             | as now                                                                                  |
| Unused            | `defaults.hours`, `agents.*.hours` shown as "not used", with **Remove**                                                     | `reset`                                                                                 |

After phase 3 only phase 4 is left: connectors, Codex posts without asking, start at login, and `connectors.install`.

## At once, where the code allows it

Today the server copies these values at the start. Phase 3 lets the running server take a saved value without a restart, the same way phase 1 does for Rejoin: the service reads them from the values in use, not from a copy.

| Setting                                                                                                                                                                                           | In use after a change                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `checkin_minutes`, `max_consecutive_agent_messages`, `max_parallel_lead_turns`, `max_message_chars`, `max_decision_chars`, `max_per_app`, `parallel_lead_mentions`, `auto_continue_delay_seconds` | at once, for what happens next; nothing already sent or counted is changed                                   |
| `turn_timeout_minutes`                                                                                                                                                                            | at once. **Shorter asks first:** "A silent turn that is already longer than this is ended at the next look." |
| `wait_timeout_seconds`                                                                                                                                                                            | the next wait; agents are told the number at their next join                                                 |
| `run_hours`, `agents.*.run_hours`                                                                                                                                                                 | the next join; a session that runs keeps its end                                                             |
| `run_warnings_minutes`                                                                                                                                                                            | at once, for warnings not given yet                                                                          |
| `pre_approvals`                                                                                                                                                                                   | at once for new requests; a request already waiting stays as it is                                           |
| GitHub token                                                                                                                                                                                      | at once for the next search (the skill search takes the new token)                                           |
| `max_attachment_mb`                                                                                                                                                                               | **restart** (a route's limit is fixed when the server starts)                                                |
| `server.port`, `server.tick_seconds`                                                                                                                                                              | **restart**; port as already designed: with its question, and both apps need `npm run setup` once            |

A room's own check-in and parallel mentions stay in the room's **Edit**, as now.

## Pre-approvals

An entry lets agents send one kind of data to one recipient without asking the lead; each use is still logged. Today they are only in the file and read at the start.

- **Add…** asks for the recipient (such as `github.com/OWNER/REPO`) and the kind (such as `code_push`), then shows one question with both, exactly as they will be matched: "From now on, agents may send **code_push** to **github.com/OWNER/REPO** without asking you, in every room and in every future request, until you remove it. Each use is still logged. Allow?" Nothing is saved without the yes.
- **Remove** asks nothing; it only takes away a permission.
- The match stays exact (case and spaces aside): no wildcards, as now. Recipient and kind are checked the same way on both paths: not empty, at most 200 characters, no line breaks, and the pair not there already.
- **Each change is one operation in the lock** (add this entry, remove that one), done on the list as it is then. An entry that another writer added or removed meanwhile stays as that writer left it; nothing is overwritten with an older copy of the list.
- **Live:** a new request is checked against the list of that moment. A request **already waiting** for the lead stays waiting after an Add (it isn't approved after the fact), and one approved already stays approved after a Remove.
- **Command line:** `npm run config -- approve <recipient> <data>` asks the same question. `--yes` is the explicit confirmation without a terminal; without a terminal and without `--yes` it refuses. `unapprove` asks nothing, as **Remove**.

## GitHub token

The same mechanics as the bot's token: an item of its own for every store, never replaced, and a pointer that changes in one step. So nothing new is tried on the Keychain, and a store that fails or is interrupted can't destroy the token in use.

- **Pasted** in a password field, sent once, never in an answer. Checked against GitHub (`/user`) before storing; a token that doesn't work isn't stored. In the tests, GitHub is a stand-in; no real token and no call to GitHub.
- **Store:** a note first (in the lock), then a new item `konfab-github-token-<random>` (macOS: through the input of `security -i`, without "replace"; Linux: a new private file), then it is **read back**; only an equal read counts.
- **Commit:** in the lock, `github-token.json` in Konfab's folder is changed to name the new item. Before that, the token in use is untouched. After it, the replaced item is given up (unused in the lock) and deleted outside it; an unsure deletion is shown, as for the bot.
- **Interrupted** at any point: either the old pointer or the new one, each naming an item that is there. A store that wasn't confirmed is a left-over, shown with **Remove it**.
- **Searches** read the pointer and the token once per search, so a search that runs while it changes uses one token, the old or the new.
- **The place of before** (`konfab-github-token`, the fixed item of today) stays usable while no pointer exists, as today. It may be used by another Konfab folder of the same user, so it is never deleted without a question, as the bot's places `a` and `b`. Two Konfab folders never share a new item.
- **Environment:** `KONFAB_GITHUB_TOKEN` comes first, as now. The page says so and offers no store; one that is stored anyway isn't used while the variable is set.
- **Remove:** the pointer first (in the lock), then the item. "Not found" is the only "not there"; anything else is said.
- **Going back** to an earlier Konfab: it reads only the place of before, so it searches without a token (fewer searches an hour) until `--github-token` is run there. The guide says so.
- **Status** in the page and with `--github-token --status`: where it comes from (environment, this folder's item, the place of before, none) and whether GitHub accepted it at the last search. Never the token.

## In the page

The **Agents** and **Advanced** sections get the rows the list already describes (name, help, field, when it takes effect), as the Rejoin section has today. New field kinds:

- **Minutes list** for `run_warnings_minutes`: such as "30, 10, 5", checked like the schema.
- **Per agent:** the agents in the file (Claude, Codex), with their name and run hours (empty means the default).
- **A setting that needs a restart** shows both values until then: "Saved: 20 MB. In use: 10 MB until Konfab restarts." It never looks active before it is. The command line says the same.
- **A shorter silent-turn limit** asks first, in the page and on the command line (`--yes` without a terminal).

## Both paths: what is left after phase 3

Every operation of today, and where it is after phase 3:

| Operation                                                                                         | Page                                                            | Command line                                  |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------- |
| Every key of `config.yaml` but `agents.<new id>` and `connectors.install`                         | yes                                                             | yes                                           |
| Name and run hours of an agent in the file                                                        | yes                                                             | yes (`agents.<id>.…`)                         |
| **A new agent in the file, or removing one**                                                      | no                                                              | by `set agents.<id>…`, used at the next start |
| Pre-approvals                                                                                     | yes                                                             | yes (`approve`, `unapprove`)                  |
| Phone notices                                                                                     | yes                                                             | yes                                           |
| GitHub token                                                                                      | yes                                                             | yes                                           |
| Connectors of both apps, `connectors.install`, Codex posts without asking, start at login (macOS) | phase 4                                                         | yes                                           |
| **A room's own settings** (check-in, parallel mentions, name, topic, folder, pause, break)        | yes (room's **Edit**)                                           | **no**                                        |
| The first sign-in and the first setup                                                             | the terminal only (by design: the page can't be reached before) | yes                                           |

Two gaps remain, and are for the lead:

- **A new agent in the file.** The file's agents are the apps that connectors join as (Claude, Codex); a new one is only useful with its own connector. So it belongs with the connectors in phase 4, in both paths.
- **A room's own settings on the command line.** Rooms are in the database, which the running server owns. A command line for them would need to go through the running server (or change the database beside it). That is a feature of its own: question 4.

## Tests

- Each setting: page, command line and a hand edit change the same value; in use when the table says; the guide's table matches the list (exists).
- **Live values, against the real behaviour:** a test per row of "At once": the room's own check-in still wins over the default, and a room without one takes the new default; a running session keeps its end, and the next join takes the new run hours; a silent turn is ended at the next look only after the yes; the told wait time changes at the next join.
- **Restart settings:** saved and in use both shown, in the page and on the command line, until a restart.
- **Pre-approvals:** the question names exactly what is matched; nothing is saved without the yes; `--yes` and the page validate the same input; an Add and a Remove from two writers at once both stay; a waiting request isn't approved by a later Add.
- **GitHub token:** a stand-in for GitHub and for the Keychain; the pointer changes in one step; interrupted after each write, the old or the new token works; a search during a change uses one token; two Konfab folders; the place of before is never deleted without the question; the token in no answer, log or file but its place.
- Documents only for what ships.

## Questions for the lead

| #   | Question                                                                                                          | I recommend                                           |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | The **GitHub token** pasted in the page, like the bot's token?                                                    | yes                                                   |
| 2   | Pre-approvals on the command line as `approve` and `unapprove`, with the same question?                           | yes                                                   |
| 3   | Settings that need a restart: show "after a restart" only, or also a **Restart Konfab** button?                   | "after a restart" only, for now                       |
| 4   | **A room's own settings on the command line:** build it (through the running server), or leave rooms to the page? | leave them to the page for now; revisit after phase 4 |
