# UI tests

**Status:** built. Requested by the lead after review found a stale-preview race that server tests could not catch.

## Why

Server rules, the API and the bridge were well covered, but the page (`web/src`) was only checked by hand. Page bugs (a checkbox layout regression, the Add agent preview race) were found late, and nothing kept older flows from breaking.

## Levels

| Level     | Where        | Tools                                                 | Runs in                                  |
| --------- | ------------ | ----------------------------------------------------- | ---------------------------------------- |
| Component | `tests/web/` | Vitest, jsdom, `@testing-library/react`, `user-event` | `npm run check` (`npm test`)             |
| Browser   | `tests/e2e/` | Playwright with Chromium, projects for light and dark | `npm run test:e2e`, `npm run check:full` |

- **Component tests** render one component with `fetch` stubbed per route. Use them for state logic: validation, enabling and disabling, request payloads, error display and ordering of async responses. Start each test file with `// @vitest-environment jsdom`. `tsconfig.web.json` type-checks `tests/web`.
- **Browser tests** build the app, then `tests/e2e/konfab-server.ts` starts the server on a free port with a throwaway `KONFAB_HOME`, a fake `HOME` (so `setup --manual` never touches real desktop-app settings) and a minimal environment. `KONFAB_GITHUB_TOKEN` is set to a synthetic value, so the server never reads a real token or the macOS Keychain. Readiness means the spawned process is still running **and** answers a login code from its own database with a Konfab session cookie, so a different service on the port can't pass. Any setup failure stops the process and removes the temporary folder; `tests/smoke/e2e-server.test.ts` checks this, including an occupied port. Keep browser tests to a few main flows; the light and dark projects share one server, so use unique names per project.
- Layout and visual polish are still checked by hand in an isolated instance in both themes.

## Rules

- Every UI bug fix ships with a test that fails without the fix.
- Prefer accessible queries (label, role, name). Give forms an `aria-label` when several forms share field names.
- Extract a component into its own file when it needs tests; `App.tsx` is large and its internals are not exported.

## First tests

- `tests/web/add-agent-form.test.tsx`: ID suggestion, full apps, plain add, skills chosen in the picker, public-skill clash choices, and no agent until a choice is made.
- `tests/web/team-skills.test.tsx`: swap two skill bundles and apply with base revisions; remove and undo; a failed apply keeps the dialog open with the error.
- `tests/web/assign-skills.test.tsx`: load, add, order and save skills; diff and update a revision; size limit; public-skill clash choices, including a failed or slow preview and a locked list; supporting-file view.
- `tests/e2e/agents.spec.ts`: sign in, create a room, add an agent with an app and skills, reorder them from the card, check its chips, post a message, pause the room.

`npx playwright install chromium` downloads the browser (about 100 MB) once per machine.
