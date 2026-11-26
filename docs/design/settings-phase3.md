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

- **Add…** asks for the recipient (such as `github.com/OWNER/REPO`) and the kind (such as `code_push`), then shows one question: "Agents may then send **code_push** to **github.com/OWNER/REPO** without asking you. Each use is still logged. Allow?" Nothing is saved without the yes.
- **Remove** asks nothing; it only takes away a permission.
- The match stays exact (case and spaces aside): no wildcards, as now.
- The command line asks the same question; without a terminal it refuses, unless `--yes` is given.
- Typing while another writer changes the list: the same conflict handling as phase 1, for the whole list.

## GitHub token

The same mechanics as the bot's token, so nothing new is tried on the Keychain:

- Pasted in a password field, sent once, never in an answer. Checked with GitHub (`/user`, its rate limit) before storing; a token that doesn't work isn't stored.
- **macOS:** the Keychain item `konfab-github-token`, through the input of `security -i`, as for the bot's token. Unlike the bot's token, this one has a single fixed place, and storing **replaces** it (`-U`), as `--github-token` does today. Replacing was seen in the first trial (2026-11-25). Then it is read back, and only that decides.
- **Linux:** a private file `~/.konfab/tokens/konfab-github-token`, with the same rules as the bot's token file; replaced by writing a new file and renaming it over the old one.
- **Environment:** `KONFAB_GITHUB_TOKEN` comes first, as now; the page says so and doesn't offer to store one.
- **Remove** deletes only that item or file. "Not found" is the only "not there"; anything else is said.
- **Status** in the page and with `--github-token --status`: where it comes from (environment, Keychain, file, none) and whether GitHub accepted it at the last search. Never the token.

## In the page

The **Agents** and **Advanced** sections get the rows the list already describes (name, help, field, when it takes effect), as the Rejoin section has today. New field kinds:

- **Minutes list** for `run_warnings_minutes`: such as "30, 10, 5", checked like the schema.
- **Per agent:** a small table of the agents in the file, with their run hours (empty means the default). Adding or removing an agent stays in the file (`page: "no"`), because the agents are made at the start.

## Tests

- Each setting: page, command line and a hand edit change the same value; in use when the table says; the guide's table matches the list (exists).
- Live values: a test per row of "At once", including that a running session keeps its end, and the question for a shorter silent turn.
- Pre-approvals: the question names exactly what is allowed; nothing saved without the yes; in use for the next request and not for a waiting one; conflicts while typing.
- GitHub token: no token in any answer, log or file but its place; stand-ins for GitHub and the Keychain; read back decides; Linux file in the container check as before.

## Questions for the lead

| #   | Question                                                                                        | I recommend                     |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | The **GitHub token** pasted in the page, like the bot's token?                                  | yes                             |
| 2   | Pre-approvals on the command line as `approve` and `unapprove`, with the same question?         | yes                             |
| 3   | Settings that need a restart: show "after a restart" only, or also a **Restart Konfab** button? | "after a restart" only, for now |
