# Get started on macOS and Linux

**Status:** implemented on `feature/get-started`; design revised after review (msg 1351). It follows the lead's asks (msg 1347) and codex's first-release requirements (msg 1348): minimal setup from a fresh clone, defaults for everything, a README **Get started**, and **macOS and Linux required**. Windows is best-effort and claimed only where tested.

## The smallest path

```bash
git clone https://github.com/hongbinyang/konfab.git
cd konfab
npm run quickstart
```

Then restart (or reload the Konfab connector in) the agent app once, and paste a join prompt from the page. The agent counts as connected only when its card says **Waiting for a turn**. Konfab never treats a written config file as proof of a connection.

**Prerequisites:** Git and **Node 24** (`>=24 <25`) from any source: nodejs.org, Homebrew `node@24`, nvm or fnm via a new `.nvmrc`, or the distro or NodeSource package. Miniconda becomes optional; `environment.yml` stays. If npm has to compile the SQLite module (no prebuilt binary for this Node and CPU), it needs build tools: the Xcode Command Line Tools on macOS, or `build-essential` and `python3` on Linux. Quickstart recognises that failure and prints the install command.

## `npm run quickstart`

`scripts/quickstart.mjs` is plain Node with no dependencies, so it runs before `npm ci`. Every step can be repeated safely.

1. **Node.** If the version isn't 24, say which version is running and how to get 24, then stop.
2. **Dependencies: a reliable install policy.** `node_modules/.konfab-install.json` records:
   - the SHA-256 of `package-lock.json`;
   - `process.versions.modules` (the Node ABI), `process.platform` and `process.arch`.

   Quickstart runs `npm ci` when this record is missing or any value differs. A matching timestamp is never enough. After installing it **proves the native module works**: a child process opens an in-memory `better-sqlite3` database. Only then is the record written, so an interrupted or failed install is retried next time. A build failure prints the build-tools hint and stops.

3. **Build:** `npm run build`. It is cheap and always run, so `dist/` can't be stale.
4. **Setup:** the existing `dist/cli/setup.js`, unchanged in behaviour (see "What setup changes").
5. **Doctor** (read-only, below). Problems are printed; only a `fail` stops quickstart.
6. **Start:** run the server in the foreground on `127.0.0.1:8787`. Print the one-time sign-in link, and open it with the platform opener (`open` / `xdg-open`). A failed open is ignored, since the link is printed.
7. **Next step:** print, per app, whether its connector entry is present and what to do: "restart or reload, then paste a join prompt; the card shows **Waiting for a turn** when connected". When an app's config file doesn't exist (app not installed, or never started), say so and point to the manual snippet (`~/.konfab/app-setup.md`, written by `setup --manual`) and the user guide.

Flag: `--no-open` skips the browser. `--check` is described under Verification.

## What setup changes (unchanged, now documented)

- It writes only the `konfab` entry under `mcp_servers` (Codex `config.toml`) or `mcpServers` (Claude Code `.claude.json`) in **existing** app config files. Other keys and entries are preserved byte for byte where possible.
- Each changed file gets a secret backup first (path printed), and a journal makes a crash recoverable.
- **Tokens are kept on reruns.** If an app's file already holds a token Konfab accepts, it is reused and that file is left as it is, so reruns don't clobber user edits elsewhere in the file.
- **Unrecoverable token** (the entry was removed or edited, and the database's token can't be matched): setup stops and changes nothing. It says "Cannot recover the existing … connector token. Restore its configuration or explicitly use `--rotate`." `--rotate` issues new tokens and rewrites only the `konfab` entries. Agents already in rooms then need the rejoin prompt.
- **Missing app config file:** the implementation will verify that setup does not create one, and fix it if it does. Instead, quickstart and doctor report the app as not set up and show the manual snippet.

## `npm run doctor`: read-only

Doctor creates nothing, rotates nothing, starts nothing and opens the database **read-only**. A missing `~/.konfab` is reported, not created. Each check prints `ok`, `warn` or `fail`, plus the fix for anything that isn't `ok`:

| Check              | Problem                                                                                                                                                              | Fix shown                                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node               | not 24                                                                                                                                                               | how to install 24 on this platform                                                                                                                                                                                                                                                    |
| Dependencies       | install record missing or different, or native module fails to load                                                                                                  | `npm run quickstart` (reinstalls), or the build-tools command                                                                                                                                                                                                                         |
| Data folder        | missing (`warn`: created on first start), or not writable (`fail`)                                                                                                   | the path and its owner and permissions                                                                                                                                                                                                                                                |
| Config             | `config.yaml` doesn't parse                                                                                                                                          | the error with file and line. Recovery: fix that line, or keep your edits by moving it aside (`mv ~/.konfab/config.yaml ~/.konfab/config.yaml.bak`) and copy your settings back into the fresh default after the next start. Rooms and skills are in `konfab.db` and aren't affected. |
| Port               | 8787 already in use                                                                                                                                                  | the process using it if `lsof` or `ss` can tell; `server.port` in `config.yaml`                                                                                                                                                                                                       |
| Connector, per app | config file missing; `konfab` entry missing; bridge path doesn't exist (checkout moved); Node path doesn't exist (Node upgraded); token not accepted by the database | `npm run setup`, or `--rotate` with its consequence stated, or the manual snippet                                                                                                                                                                                                     |
| GitHub token       | none (`warn` only)                                                                                                                                                   | public search works with lower limits; how to add one on this platform                                                                                                                                                                                                                |
| Start at login     | not macOS (`warn`)                                                                                                                                                   | not available here; run `npm start`                                                                                                                                                                                                                                                   |

## Defaults: nothing to edit

Every setting has a default in `src/server/config.ts`, and `ensureHome` writes the default `config.yaml` on first start. A new test starts Konfab with **no** `config.yaml` and none of the variables below, and checks every default.

| Setting                    | Default                                                                                                    | Override                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Data folder                | `~/.konfab`                                                                                                | `KONFAB_HOME`                                                                    |
| Server                     | `127.0.0.1:8787`, loopback only                                                                            | `server.port`; the host isn't configurable                                       |
| Codex connector file       | `~/.codex/config.toml`                                                                                     | `CODEX_HOME`                                                                     |
| Claude Code connector file | `~/.claude.json`                                                                                           | `CLAUDE_CONFIG_DIR`                                                              |
| GitHub token               | none                                                                                                       | `GITHUB_TOKEN`; on macOS also the Keychain via `npm run setup -- --github-token` |
| Agents                     | `claude` ("Claude"), `codex` ("Codex")                                                                     | `agents:`                                                                        |
| Run window                 | 5 h, warnings at 30/10/5 min                                                                               | `defaults.run_hours`, `defaults.run_warnings_minutes`                            |
| Waits and turns            | wait 50 s, turn timeout 30 min, check-in 2 min, auto-continue after 180 s                                  | `defaults.*`                                                                     |
| Limits                     | 50 agent messages in a row, message 20,000 chars, decision 4,000 chars, attachment 10 MB, 4 agents per app | `defaults.*`, `multi_agent.max_per_app`                                          |

## Platform differences

| Piece                                           | macOS                                                  | Linux                        | Windows (best-effort)                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server, database, page                          | yes                                                    | yes                          | expected; CI only                                                                                                                                        |
| Finding `node` for the connector entry          | fix: `path.delimiter`, keep the stable-path preference | same fix                     | same fix, plus `node.exe`                                                                                                                                |
| Skill folder writes (`O_NOFOLLOW`, create-only) | yes                                                    | yes                          | **fail closed**: where `O_NOFOLLOW` isn't available, writes refuse with "Skill folder writes aren't supported on this platform yet". No weaker fallback. |
| GitHub token                                    | env or Keychain                                        | env                          | env                                                                                                                                                      |
| Start at login                                  | launchd                                                | not provided; doctor says so | not provided                                                                                                                                             |
| Browser opener                                  | `open`                                                 | `xdg-open`                   | `start`                                                                                                                                                  |
| Symlink tests                                   | run                                                    | run                          | skipped where symlinks aren't permitted                                                                                                                  |

No new token file and no uninstall command: neither is needed for a first run. Uninstall stays as documented in the user guide.

## Verification

The automated bridge simulation and the manual real-agent test are kept apart, and only what was actually run is claimed.

1. **Automated: `npm run quickstart -- --check` is safe by construction.** It always:
   - creates its own temporary directory and uses it as `KONFAB_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `HOME` for every child process, overriding any inherited values;
   - removes `KONFAB_GITHUB_TOKEN` and any other credential-like variables from the child environment, and sets `KONFAB_ISOLATED=1` so the server never reads the Keychain;
   - picks a free port by binding port 0;
   - starts the server, writes temporary connector files via setup, then starts `dist/bridge/index.js` with exactly the command, arguments and env from that temporary Codex entry, and joins a fresh room as `codex` over MCP;
   - posts, receives and passes a turn, stops and restarts the server, and checks that the room and messages persist;
   - stops its own processes and deletes only the directory it created (after checking its path).

   Tests:
   - run `--check` with `HOME`, `KONFAB_HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` pointing at sentinel folders with real-looking files, then assert that every sentinel file is byte-identical and no new file appeared;
   - make the port busy;
   - kill the bridge mid-run;
   - doctor creates nothing (a missing home stays missing) and changes no files (hashes before and after).

2. **CI matrix** (GitHub Actions; fresh checkout; `quickstart --check --no-open`, then `npm run check`):
   - required: `macos-latest` (arm64) and `ubuntu-latest` (x64);
   - informational: `windows-latest`, allowed to fail, with no support claim.
3. **Install-policy tests:**
   - after a changed lockfile hash, and after a changed recorded ABI, quickstart reinstalls;
   - an interrupted install, with the record not yet written, is retried;
   - a native module that fails to load stops quickstart with the hint.
4. **Manual real-agent checks before release.** Record OS, CPU, Node, steps, minutes and problems in `docs/test-plan.md`. Each combination is tested or marked "untested":

   |                            | Codex app     | Codex CLI | Claude desktop (Code tab) | Claude Code CLI |
   | -------------------------- | ------------- | --------- | ------------------------- | --------------- |
   | macOS (clean user account) | test          | test      | test                      | test            |
   | Ubuntu 24.04 VM            | n/a if no app | test      | n/a (no Linux app)        | test            |
   | Windows                    | untested      | untested  | untested                  | untested        |

   Each tested cell: an agent joins and replies, then a server restart (rooms kept), an update (`git pull`, quickstart) and the documented uninstall. The README lists only tested combinations, and says the connector file locations were confirmed by these runs.

## README "Get started"

The prerequisites line, the three commands, "restart the agent app, paste a join prompt, wait for **Waiting for a turn**", then stop, update and `npm run doctor`, with one line per platform. It links to the user guide for manual connector setup and uninstall.

## Docker: a conditional assessment, decided by measurement

Docker can help a person who already uses Docker and wants the server isolated: it gives a reproducible build with no local Node install for the server. It doesn't remove the host side for the desktop or CLI agents in the current design, because the apps start the stdio bridge on the host from their own config files. So the host still needs Node (or a packaged bridge) and connector setup.

Whether that is a net gain depends on who is installing: with Docker already installed, it might save the build step; without it, installing Docker Desktop is an extra, larger prerequisite. The evaluation plan (msg 1346) times both cases against the native quick start before deciding. Nothing in this package depends on Docker.

## Out of scope

npm, Homebrew and app packaging (later, building on quickstart); Windows support claims; exposing the server beyond the local machine.

## Implementation notes

- **Code:** `scripts/quickstart.mjs`, `src/cli/doctor.ts`, `src/cli/check.ts`, `.github/workflows/get-started.yml`, and `.nvmrc`. Setup changes: the Node lookup uses `path.delimiter` (and `node.exe` on Windows); a connector is written only when the app's own folder or file exists (`~/.codex/` for Codex, `.claude.json` or `.claude/` for Claude Code); otherwise setup says so. Skill folder writes fail closed without `O_NOFOLLOW`.
- **The check never talks to the default port.** Setup first runs with the default config, as on a first run. The check then switches to a free port and runs setup again, which also proves a rerun keeps the tokens. It refuses to start the bridge unless the connector URL is its own server.
- **Quickstart never reinstalls through a linked `node_modules`.** `npm ci` deletes the folder first, so through a link it would empty another checkout's dependencies. Quickstart stops and explains instead (found the hard way during development, now tested).
- **`npm run doctor` needs no dependencies and no build.** `scripts/doctor.mjs` is plain Node. It checks Node, the install (present, a link or not, the recorded fingerprint, whether SQLite loads) and whether the build exists or is older than the source, and it never installs or builds. Only when dependencies load and a build exists does it run the full read-only checks in `dist/cli/doctor.js`.
- **Starting proves it is this install's Konfab.** The port comes from the sign-in link that `login-link` prints, which uses the parsed config.
  - If the port is busy, quickstart signs in with a fresh code from this database. If that works, Konfab is already running: it prints a new link and starts nothing. Anything else on the port is an error naming the port, how to find the program, and `server.port`.
  - After starting, it reports "running" only once a sign-in code from this database is accepted.
  - A server that exits, never answers (15 s, then stopped) or turns out to be another program, and a sign-in link that can't be made, all stop quickstart with the next step to take.
