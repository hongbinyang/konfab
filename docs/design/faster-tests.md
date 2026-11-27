# Faster tests

**Status:** #1 to #4 built (the lead chose #3 on 2026-11-27); #5 found nothing to remove. The lead asked (2026-11-27) for quicker tests: drop deprecated and redundant ones, cover more with less, and change how they run, with the time measured before and after.

## Where the time went (one run, before)

`npm run check:full` on main `84c6184`, this Mac (12 cores), parts run one after another:

| Part                           |   Time | Long pole                                                           |
| ------------------------------ | -----: | ------------------------------------------------------------------- |
| Types (server, page)           |  4.8 s |                                                                     |
| Lint                           |  2.8 s |                                                                     |
| Format                         |  3.7 s |                                                                     |
| Unit, integration, page (1206) | 12.7 s | `integration/bridge.test.ts` 11.8 s                                 |
| Build                          |  2.2 s |                                                                     |
| Smoke (105)                    |  116 s | `smoke/rejoin-watch.test.ts` 115 s; the other files end within 20 s |
| Browser (80 = 40 × 2 themes)   |  102 s | one worker, one shared server, every test in light and in dark      |
| **All**                        |  244 s |                                                                     |

**Smoke:** the watcher's own waits are real: 10 s for an answer at its start, 30 s between looks at the processes above it. Five tests wait for them one after another (4 × 15 s and 31 s = 91 s), all in one file, while the other files finish in parallel within 20 s.

**Browser:** `workers: 1` because all specs share one server started in the global setup, and some change its settings. Each of the 40 tests runs twice, light and dark; only a few look at colors or focus.

**Deprecated or redundant:** nothing is skipped, marked deprecated or left behind (the `skipIf` are for Windows and root). Names like `phase1.test.ts` and `old-bridge.test.ts` still test what Konfab does today (rooms, pause, run windows; connectors started before an upgrade). So removal must rest on evidence, not names (below).

## Changes

| #   | Change                                                                                                                                                                                                                                                                                |                                          Expected | Risk, and how it's kept small                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | **Smoke:** each waiting watcher test gets its own stand-in server and runs concurrently (`it.concurrent`), or in its own file; nothing in the watcher changes, its waits stay real                                                                                                    |                                       116 → ~35 s | the stand-in is shared today; each test then has its own, so they can't disturb each other                             |
| 2   | **Browser:** a server per worker (a worker-scoped fixture instead of the global setup), 4 workers                                                                                                                                                                                     |                                       102 → ~35 s | tests already assume a fresh server per run; per worker they keep that. The flaky dark focus test is watched in 5 runs |
| 3   | **Browser, dark theme:** only the specs that check colors, contrast or focus run in dark too (the rest once)                                                                                                                                                                          |                further ~35 → ~25 s, 80 → ~50 runs | **the lead's choice**: dark-only bugs elsewhere would be caught later. Without it, #2 alone                            |
| 4   | **Static checks:** `eslint --cache` and `prettier --cache` (cache in `node_modules/.cache`, never committed)                                                                                                                                                                          |                        6.5 → ~2 s on a second run | a stale cache: both tools key it on content and config                                                                 |
| 5   | **Redundant tests:** for each candidate file, coverage of the whole suite with and without it (`vitest --coverage`); only tests whose lines and branches are all covered elsewhere **and** that test no behavior stated in REQUIREMENTS are merged or removed, listed with the reason | small in time (unit is 13 s); fewer tests to keep | wrong removal: each one is named in the review with its coverage diff                                                  |

Not changed: the watcher's and server's real timings, the test content of smoke and browser tests, what `check` and `check:full` run.

## Measuring

Same Mac, nothing else heavy running, after `npm run build`; each part timed alone as today, **3 runs, the median**; before on main `84c6184`, after on the branch head. Per file and per test from Vitest's and Playwright's JSON reports. The table before and after goes into the review and this document.

**Expected:** about 244 s → **~90 s** with #1, #2, #4; ~80 s with #3 as well.

## Result

**With #3** (the lead's choice): the 40 browser tests run in light, and the 4 whose look depends on the theme (tagged `@themed`: the focus ring, and the tests that take screenshots for review) in dark as well: 44 runs instead of 80. Browser 24 s (median of 3); a real `npm run check:full` **80 s cold, 75 s warm**, against 249 s before.

The measurements below are before #3.

Main `84c6184` against branch `test/faster`, same Mac, each part in `check:full`'s order, median of 3 runs; "cold" without the lint and format caches, "warm" with them.

| Part                    |  Before |                  After |
| ----------------------- | ------: | ---------------------: |
| Types                   |   4.2 s |                  4.2 s |
| Lint                    |   2.6 s | 2.6 s cold, 0.6 s warm |
| Format                  |   3.5 s | 3.5 s cold, 0.3 s warm |
| Unit, integration, page |  12.4 s |                 12.4 s |
| Build and smoke         | 117.5 s |                 33.3 s |
| Browser                 | 100.9 s |                 34.3 s |
| **All**                 |   241 s |   90 s cold, 85 s warm |
| `npm run check:full`    |   249 s |   90 s cold, 85 s warm |

The same tests run: 1206, 105 and 80.

**Caches:** both are keyed on content. A change of the Prettier or ESLint config was seen at once (tried); ESLint's key holds its version, Node's and the whole config with each plugin's name and version, Prettier's its version and options.

**Removals (#5):** none. Nothing is skipped or deprecated. Without `phase1.test.ts` 23 statements and 34 branches go uncovered, without `service.test.ts` 53 and 65, without `old-bridge.test.ts` 9 statements: each tests something no other test reaches.

**Reliability:** browser tests in 4 workers: 29 full runs, and one with every test 5 times (400 passed). Two runs failed once each, both in the series of three run right after the smoke tests; their output wasn't kept, and the 20 runs since (8 of them in the same order, with logs) passed. No process or folder was left behind.
