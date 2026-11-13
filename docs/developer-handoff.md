# Developer handoff

This guide orients a newcomer to the repository as of commit `5e564ea` (busy-agent check-in intervals). Start with the [README](../README.md) and [user guide](user-guide.md) for installation and normal use, then read [AGENTS.md](../AGENTS.md) before changing the repository. Room instructions and the lead's current decisions take precedence. The baseline [architecture](../DESIGN.md) and [requirements](../REQUIREMENTS.md) contain historical material; feature design notes are indexed [here](design/README.md). Code and tests determine the behavior of a specific checkout.

## Set up and work safely

Use Node 24 and `npm ci` (the README gives the conda setup). `npm start` builds and starts the server; `npm run setup` builds and configures desktop connectors and can modify the user's app settings. Use a separate worktree and branch; coordinate shared checkouts and pushes with the room's advisory lock. Never commit credentials, connector settings or live data. GitHub pushes require the room's scoped approval and a fresh base/head check.

Konfab defaults to `~/.konfab` for config, SQLite, attachments and other local state; `KONFAB_HOME` selects another home. Use a temporary home, a distinct port and synthetic credentials for experiments; do not run destructive tests on a live room. Public source searches can contact GitHub. See the [credential design](design/github-keychain.md) and user guide before working with tokens. A temporary home alone does not make connector setup or system Keychain operations safe to run against a real account.

## Where to start in the code

| Area                                        | Starting point                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| Server startup and dependency wiring        | `src/server/index.ts`, `src/server/runtime.ts`, `src/server/config.ts` |
| HTTP routes, auth and live updates          | `src/server/api/`                                                      |
| Room state, turns, sessions and permissions | `src/server/domain/service.ts`                                         |
| SQLite connection and ordered migrations    | `src/server/db/index.ts`                                               |
| MCP bridge and tool schemas                 | `src/bridge/`                                                          |
| Skills, sources and roles                   | `src/server/domain/skills.ts`, `skill-sources.ts`, `roles.ts`          |
| Web client                                  | `web/src/App.tsx`, `web/src/api.ts`, `web/src/styles.css`              |
| Connector and command-line setup            | `src/cli/`                                                             |

The server owns persistent state; the stdio bridge calls the local HTTP API on an agent's behalf, while the React client uses HTTP and server-sent events. Read the actual schemas and migrations when changing contracts. Migrations are applied in order using SQLite `user_version`; each migration is transactional and checked for foreign-key violations.

## Invariants worth preserving

- An ordinary room turn is serialized. The optional, off-by-default parallel lead-mention prototype permits additional explicitly addressed agents to work concurrently, with at most one active turn per agent. It is cooperative and shared-checkout locks are advisory. See [parallel mentions](design/parallel-lead.md).
- A busy agent's check-in interval is guidance, not a timer or delivery guarantee. Room overrides allow 1, 2, 5 or 10 minutes; a null override inherits `defaults.checkin_minutes` (2 by default). It does not alter waiting-agent polling. See [check-in design](design/checkin-interval.md).
- On restart, active turns with valid active session owners are retained; orphaned active turns are abandoned and requeued. Test durable changes by closing and reopening the real database and rebuilding the service and app.
- Role assignments and skill revisions are pinned. Active turns retain their role snapshot across changes; a subsequent turn receives the new assignment. See [role change](design/role-change-notice.md) and [role swap](design/role-swap.md).
- Room instructions ask agents to request permission before restricted disclosures; the app cannot enforce all actions taken outside it. A code push approval has an exact repository, branch and commit range; verify them again immediately before pushing.

## Validate and hand off

Run focused tests while developing, then `npm run check` before every commit. It runs type checks, lint, formatting, unit/integration tests and built-app smoke tests. For restart behavior, use a real reopen test; for UI changes, add component tests in `tests/web` (Vitest, jsdom, Testing Library) and, for main flows, Playwright tests in `tests/e2e`; run `npm run check:full` (first run `npx playwright install chromium`), and still check layout in an isolated instance in both themes when appropriate. See [UI tests](design/ui-tests.md). Automated scripted-agent tests do not establish real desktop-client behavior. Record what was tested and what remains unverified, request the project review required by `AGENTS.md`, and give the next person the branch and exact commit hash. See the [test plan](test-plan.md) for test levels and historical results.
