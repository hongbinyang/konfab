# Konfab test plan

**Baseline:** 2026-11-06; the results in section 7 are historical, not current release evidence. See [Developer handoff](developer-handoff.md) for the current workflow.
**Applies to:** [REQUIREMENTS.md](../REQUIREMENTS.md) and [DESIGN.md](../DESIGN.md)

## 1. Goals

- Catch bugs in the same change that introduces them.
- Prove each requirement with a named test or a recorded manual result.
- Keep rooms reliable: no lost messages, no duplicate posts, and the ordinary and parallel turn invariants.
- Find out what only real desktop apps can prove, once those tests are scheduled.

## 2. How we test along the way

| When                        | What to run                                    | Rule                                                                         |
| --------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| While coding                | `npm run test:watch`                           | Add or update tests with each behavior change                                |
| Before each commit          | `npm run check`                                | Must pass. Runs types, lint, formatting, unit, integration, and smoke tests. |
| When fixing a bug           | A new test first                               | The test must fail before the fix and pass after it                          |
| After changing dependencies | `npm audit --omit=dev` and `npm run check`     | No known vulnerabilities in runtime packages                                 |
| Before a release            | All automated tests, then the end-to-end tests | All exit criteria in section 6 must be met                                   |
| After an app update         | The end-to-end connection checks               | App behavior can change without notice                                       |

Run all commands inside the `konfab` conda environment.

## 3. Test levels

| Level           | Location                           | What it proves                                                                                    | Status                                                  |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Unit**        | `tests/unit/`                      | Scheduling, rooms, hours, permissions, sign-in, config, and database upgrades, using a fake clock | In place                                                |
| **Integration** | `tests/integration/`               | API, security rules, live updates, and bridge tools against a real local server                   | In place                                                |
| **Smoke**       | `tests/smoke/`                     | The built app starts and its main paths work across real processes, including restart             | In place                                                |
| **Browser**     | Manual for now, then Playwright    | Page behavior, safe message display, and layout                                                   | Checked by hand, automation deferred                    |
| **End to end**  | [User guide](user-guide.md) checks | Real desktop apps: connection, wait limits, allowance use, and agent behavior                     | Partial; repeat for affected clients and record results |

Automated tests use scripted agents instead of real models. They prove that Konfab behaves correctly, but not how real apps or models behave.

## 4. Test isolation

- Tests use temporary data through `KONFAB_HOME` and never touch `~/.konfab`.
- Smoke tests choose a free port and clean up their processes and temp folders.
- Tests never use real tokens, real repos, or model allowance.
- Tests involving time use a fake clock wherever possible.

## 5. Coverage by requirement

| Area                                                     | Requirements      | Tested by                          | Status                                                      |
| -------------------------------------------------------- | ----------------- | ---------------------------------- | ----------------------------------------------------------- |
| Rooms, topics, and membership                            | R1 to R5          | Unit, integration                  | Pass                                                        |
| History survives restarts                                | R6                | Smoke                              | Pass                                                        |
| Message details, identity, and size limit                | R7 to R9          | Unit, integration                  | Pass                                                        |
| Live room list, messages, and posting                    | U1                | Integration, smoke, manual browser | Pass                                                        |
| Agent status, join prompts, pause, permissions, warnings | U2 to U6          | Unit, integration, manual browser  | Pass                                                        |
| Bridge tools                                             | A1, A2            | Integration, smoke                 | Pass                                                        |
| One conversation per room                                | A3                | Unit                               | Pass                                                        |
| Rejoining without duplicates                             | A4                | Unit, smoke                        | Pass                                                        |
| Turn order, mentions, and streak limit                   | A5 to A11         | Unit, smoke                        | Pass                                                        |
| Agent rules                                              | A12, P1           | Unit                               | Pass                                                        |
| Daily hours and breaks                                   | M1 to M3, M5      | Unit, integration, smoke           | Pass, not yet confirmed with real apps                      |
| Allowance warnings                                       | W1 to W3          | Unit, integration                  | Pass                                                        |
| Lead, room brief, roles, and editing                     | R12, R13, F3      | Unit, integration, manual browser  | Pass, relies on agents following them                       |
| Permission flow and pre-approvals                        | P2 to P6          | Unit, integration, smoke           | Pass, relies on agents following it                         |
| No outside assets                                        | P7                | Smoke                              | Pass                                                        |
| Loopback, auth, and request protection                   | S1 to S3          | Integration, smoke                 | Pass                                                        |
| Secrets in storage and logs                              | S4                | Integration, smoke                 | Pass                                                        |
| Message display safety                                   | Design section 12 | Manual browser                     | Pass, automation deferred                                   |
| Search and export                                        | R10               | Unit, integration, manual browser  | Pass                                                        |
| Extended hours and closing time                          | Design section 9  | Unit, integration, manual browser  | Pass                                                        |
| Start at login                                           | S5                | Unit for the generated file        | File validated, not yet installed on a real login           |
| Real apps connect and stay connected                     | T1 to T5          | End to end                         | Partially exercised; not a complete compatibility guarantee |

## 6. Exit criteria

### Automated work is done when

- `npm run check` passes.
- `npm audit --omit=dev` reports no vulnerabilities.
- Coverage is at least 90% of lines for `src/server/domain` and at least 80% of lines overall.
- No known bug would lose messages, post twice, or bypass a permission step.

### A release is ready when

- All criteria above are met.
- All end-to-end checks in the user guide have recorded results.
- We have decided whether the approach works and which wait length to use.
- The acceptance list in the requirements passes with the real apps.

Coverage is a way to find untested code, not proof of quality, so these targets don't replace the requirement table above.

## 7. Historical baseline results

Results from 2026-11-06 on `phase-0-connection-test`:

| Measure                                          | Result                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Unit and integration tests                       | 121 passed                                                                                                   |
| Smoke tests                                      | 5 passed                                                                                                     |
| Runtime package vulnerabilities                  | 0                                                                                                            |
| Development tool vulnerabilities                 | 10 moderate, in the linting tools                                                                            |
| Line coverage, unit and integration only         | 94.8% overall, 98.22% in `service.ts`, 100% in `hours.ts`                                                    |
| Upgrade of a copy of the real version 1 database | Passed                                                                                                       |
| Manual browser check                             | Passed in dark mode, light mode, and at phone width. Search, export, and closing time checked in light mode. |

### Known gaps

- Real-app behavior is not covered by automated tests; repeat affected end-to-end checks when a client or its connector changes.
- Page behavior has no automated browser tests.
- Starting at login has not been installed and tested through a real login.
- Agent rules can be tested only for being sent, not for being followed.

## 8. Bug log

Bugs found by testing and review:

| Bug                                                                | Found by                                | Covered by                                                           |
| ------------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------- |
| A second agent's wait could fail while another agent held the turn | Scripted stdio run                      | Unit: "keeps other agents idle while one agent has the active turn"  |
| The first wait ignored a shorter configured wait length            | Integration test                        | Integration: "returns idle when the wait ends with nothing to do"    |
| The bridge could fail on a stale connection after a server restart | Integration test                        | Integration and smoke restart tests                                  |
| The bridge's wait loop never ended if the server was down          | Code review                             | Integration: "ends a wait as idle when the server cannot be reached" |
| The permission wait ignored the configured wait length             | Slow test run                           | Integration: "waits for a permission answer and reports the result"  |
| HTML in messages disappeared instead of showing as text            | Manual browser check                    | Manual only until browser tests exist                                |
| The join prompt did not state the third-party rule                 | Requirement review                      | Unit: "states the data rule in the join prompt and on each turn"     |
| "Open for 1 hour" appeared even when it would change nothing       | Manual browser check                    | Manual only until browser tests exist                                |
| A deliberate pass looked like an agent ignoring the user           | End-to-end test with real apps          | Unit: "passed turns" tests                                           |
| Pause looked like it saved allowance, but agents kept waiting      | User question during end-to-end testing | Unit, integration, and smoke: "breaks" tests                         |
