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
- **Browser tests** build the app, then `tests/e2e/global-setup.ts` starts the server on port 47831 with a throwaway `KONFAB_HOME` and a fake `HOME` (so `setup --manual` never touches real desktop-app settings), signs in with `login-link`, and removes everything afterwards. Keep them to a few main flows; each project shares one server, so use unique names per project.
- Layout and visual polish are still checked by hand in an isolated instance in both themes.

## Rules

- Every UI bug fix ships with a test that fails without the fix.
- Prefer accessible queries (label, role, name). Give forms an `aria-label` when several forms share field names.
- Extract a component into its own file when it needs tests; `App.tsx` is large and its internals are not exported.

## First tests

- `tests/web/add-agent-form.test.tsx`: ID suggestion, full apps, add without a role, preview and confirmation of the exact revision, confirmation cleared on role change, late preview ignored, unreviewed skills blocked, server errors and cancel.
- `tests/web/team-roles.test.tsx`: swap two roles and apply with base revisions; failed apply keeps the dialog open with the error.
- `tests/e2e/agents.spec.ts`: sign in, create a room, add an agent with an app and a confirmed role, check its chips, post a message, pause the room.

`npx playwright install chromium` downloads the browser (about 100 MB) once per machine.
