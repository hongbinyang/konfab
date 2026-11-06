# Konfab test plan

**Updated:** 2026-11-06
**Applies to:** [REQUIREMENTS.md](../REQUIREMENTS.md) and [DESIGN.md](../DESIGN.md)

## 1. Goals

- Catch bugs in the same change that introduces them.
- Prove each requirement with a named test or a recorded manual result.
- Keep the room reliable: no lost messages, no duplicate posts, and one active turn per room.
- Find out early what only real desktop apps can prove.

## 2. How we test along the way

| When                        | What to run                                                     | Rule                                                                              |
| --------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| While coding                | `npm run test:watch`                                            | Add or update tests with each behavior change                                     |
| Before each commit          | `npm run check`                                                 | Must pass. Runs types, lint, formatting, unit, integration, and end-to-end tests. |
| When fixing a bug           | A new test first                                                | The test must fail before the fix and pass after it                               |
| Before finishing a phase    | `npm run check`, `npm run test:coverage`, and the manual checks | All exit criteria in section 6 must be met                                        |
| After changing dependencies | `npm audit --omit=dev` and `npm run check`                      | No known vulnerabilities in runtime packages                                      |
| After an app update         | The manual connection checks                                    | App behavior can change without notice                                            |

Run all commands inside the `konfab` conda environment.

## 3. Test levels

| Level           | Location                             | What it proves                                                                             | Status                               |
| --------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| **Unit**        | `tests/unit/`                        | Scheduler, mentions, streak limit, recovery rules, using a fake clock and in-memory SQLite | In place                             |
| **Integration** | `tests/integration/`                 | API, security checks, and bridge tools against a real local server                         | In place                             |
| **End to end**  | `tests/e2e/`                         | Built setup command, server, and bridge processes over real stdio, including restart       | In place                             |
| **Browser**     | `tests/browser/` with Playwright     | Page behavior, safe message display, and phone layout                                      | Phase 1. Checked by hand in Phase 0. |
| **Real apps**   | [Setup guide](setup-guide.md) checks | Real connection, wait limits, allowance use, and agent behavior                            | Manual, not yet run                  |

Automated tests use scripted agents instead of real models. They prove that Konfab behaves correctly, but not how real apps or models behave.

## 4. Test isolation

- Tests use temporary data through `KONFAB_HOME` and never touch `~/.konfab`.
- End-to-end tests choose a free port and clean up their processes and temp folders.
- Tests never use real tokens, real repos, or model allowance.
- Tests involving time use a fake clock wherever possible.

## 5. Coverage by requirement

### Phase 0

| Behavior                                                           | Requirement       | Test                    | Status          |
| ------------------------------------------------------------------ | ----------------- | ----------------------- | --------------- |
| Unaddressed message gives each member a turn in order              | A6                | Unit                    | Pass            |
| @mention gives a turn only to named agents                         | A7                | Unit, end to end        | Pass            |
| Agents can mention each other                                      | A7                | Unit, end to end        | Pass            |
| One active turn per room                                           | A5                | Unit, end to end        | Pass            |
| Limit of 5 consecutive agent messages                              | A11               | Unit                    | Pass            |
| User message resets the streak                                     | A10, A11          | Unit                    | Pass            |
| Unseen messages are delivered, including ones posted during a turn | A8                | Unit                    | Pass            |
| No duplicate post for one turn                                     | A4                | Unit                    | Pass            |
| Timed-out turn is skipped, and its messages come again later       | A9                | Unit                    | Pass            |
| Rejoining replaces the old session                                 | A4                | Unit                    | Pass            |
| Unresponsive agent does not block others                           | A9                | Unit                    | Pass            |
| Server restart keeps sessions and history                          | R6, A4            | Unit, end to end        | Pass            |
| Invalid token is rejected                                          | S2                | Integration, end to end | Pass            |
| Untrusted host or origin is rejected                               | S3                | Integration, end to end | Pass            |
| Tokens are not stored in the database in plain text                | S2, S4            | End to end              | Pass            |
| Local data files have restricted permissions                       | Design section 5  | End to end              | Pass            |
| Page shows HTML in messages as plain text                          | Design section 12 | Manual browser check    | Pass            |
| Page fits a phone-width screen                                     | Design section 11 | Manual browser check    | Pass            |
| Real apps connect and stay connected                               | T1 to T5          | Real apps               | **Not yet run** |

### Phase 1

Each item below gets its tests when the feature is built.

| Area                 | Requirements | Required tests                                                                                                                    |
| -------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Rooms and membership | R1 to R5     | Create, rename, and archive. Only the user can manage rooms. Agents cannot read rooms they are not in.                            |
| Page                 | U1 to U6     | Browser tests for live updates, state display, copy prompt, pause, and permission answers                                         |
| Daily hours          | M1 to M3     | Fake clock tests for start, end, past midnight, active days, an in-progress turn, queued messages, and the `closed` status        |
| Allowance warnings   | W1 to W3     | Report display, and the warning when an agent stops responding                                                                    |
| Local access         | F3           | Writer instruction reaches agents in each turn                                                                                    |
| Permissions          | P1 to P7     | Pending until answered, approve, deny, pre-approval match and non-match, logging, and no outside requests from the page or server |
| Security             | S1 to S4     | Binds to loopback only, page sign-in, cookie flags, CSP, malicious Markdown, and log redaction                                    |
| Reliability          | R6, A4       | Crash during a write, restart during a turn, and upgrade from an older database                                                   |

## 6. Phase exit criteria

### Phase 0 is done when

- `npm run check` passes.
- `npm audit --omit=dev` reports no vulnerabilities.
- All real-app checks in the setup guide have recorded results.
- We have decided whether the approach works and which wait length to use.

### Phase 1 is done when

- `npm run check` passes, including browser tests.
- Every MUST requirement has a passing test or a recorded manual result.
- Coverage is at least 90% of lines for `src/server/domain` and at least 80% of lines overall.
- The acceptance list in the requirements passes with the real apps.
- No known bug would lose messages, post twice, or bypass a permission step.

Coverage is a way to find untested code, not proof of quality, so these targets don't replace the requirement table above.

## 7. Current results

Results from 2026-11-06 on `phase-0-connection-test`:

| Measure                                  | Result                                        |
| ---------------------------------------- | --------------------------------------------- |
| Unit and integration tests               | 27 passed                                     |
| End-to-end tests                         | 3 passed, plus 3 repeat runs with no failures |
| Runtime package vulnerabilities          | 0                                             |
| Development tool vulnerabilities         | 10 moderate, in the linting tools             |
| Line coverage, unit and integration only | 83.72% overall, 94.32% in `service.ts`        |

### Known gaps

- `config.ts` and `runtime.ts` run only in end-to-end tests, so they show 0% in the coverage report.
- Server-Sent Events have no automated test, and the page has only been checked by hand.
- The bridge's progress notifications and retry after a lost connection have limited direct tests.
- Nothing has been run with the real apps.

## 8. Bug log

Bugs found by testing, each with a test that now covers it:

| Bug                                                                | Found by           | Covered by                                                                           |
| ------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------ |
| A second agent's wait could fail while another agent held the turn | Scripted stdio run | Unit: "keeps other agents idle while one agent has the active turn", plus end to end |
| The first wait ignored a shorter configured wait length            | Integration test   | Integration: "returns idle when the wait ends with nothing to do"                    |
| The bridge could fail on a stale connection after a server restart | Integration test   | Integration tests that restart on the same port, plus end to end                     |
| The bridge's wait loop never ended if the server was down          | Code review        | **No direct test yet.** Add one in Phase 1.                                          |
