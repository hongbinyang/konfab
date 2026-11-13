# Library v2: feasibility spike and design

**Status:** built (live public search, progressive descriptions, legacy index removal). The role parts are superseded: assigning a public skill now adds it to the agent's skill list ([skill-based assignments](skill-assignment.md), [skill picker](skill-picker.md)) instead of creating a role around it.

Status: proposal for review. The room's description of the approved mockup is the UX reference; this spike did not inspect the private artifact itself. No production code, user data or real source cache was modified.

## Finding: path discovery works, complete description search does not come for free

On 2026-11-10, from this machine without credentials, one GitHub `commits/HEAD` request resolved an immutable commit; a recursive Git tree request at that commit listed candidate `SKILL.md` paths; one raw request fetched a sample manifest at that same commit. No response bodies were persisted. Times are single warm-network observations, not service guarantees. Tree sizes below are the earlier direct `trees/HEAD` responses; candidate counts are paths, not validated or unique skills.

| Public repository        | Candidate manifests | Tree response | Tree time | Sample manifest time |
| ------------------------ | ------------------: | ------------: | --------: | -------------------: |
| anthropics/skills        |                  20 |     139,238 B |    0.35 s |               0.33 s |
| openai/plugins           |                 536 |   2,094,712 B |    0.56 s |               0.23 s |
| vercel-labs/agent-skills |                   9 |     130,824 B |    0.31 s |               0.20 s |
| obra/superpowers         |                  15 |      75,173 B |    0.32 s |               0.23 s |
| mattpocock/skills        |                  39 |      68,109 B |    0.33 s |               0.16 s |
| microsoft/skills         |                 211 |     994,148 B |    0.44 s |               0.22 s |
| huggingface/skills       |                  26 |      68,972 B |    0.32 s |               0.23 s |

All seven tree responses succeeded and reported `truncated: false`. This establishes path discovery only: it does **not** establish that every candidate is valid, licensed, public, or usable as a role. Commit lookups took 0.27–0.42 s each. A first search of all seven needs 14 GitHub API calls for commit plus tree, plus one raw-content request per manifest actually read; an individual preview needs at least its manifest and potentially licence and file metadata. A full description search would require reading up to 856 manifests in these observations; fetching only the visible page means results are incomplete for terms that occur only in unread descriptions. Trees do not contain descriptions or licence text. Do not label this a complete cross-source description search. Path/name-only results should be clearly labelled, or a publisher-provided searchable index must be identified and verified; if neither meets the lead's requirement, return with options before building.

GitHub documents a [60/hour unauthenticated primary REST limit and generally 5,000/hour authenticated](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), subject to shared IP/account and secondary limits. GitHub documents [recursive tree truncation at 100,000 entries or 7 MB](https://docs.github.com/en/rest/git/trees); handle `truncated` explicitly, walking bounded subtrees or reporting incomplete results. Search endpoint quotas differ. Raw-host behavior and secondary limits also need testing; do not assume unlimited raw fetches. No GitHub token was available in the spike environment; authenticated latency and limits were **not measured**, and sending any credential to GitHub requires the user's scoped permission. The above unauthenticated results are not evidence of authenticated performance.

## Design for a remote session

Create a server-side ephemeral search session, bounded globally to 16 MiB and per entry to 512 KiB, with a 5-minute idle TTL and 15-minute absolute TTL, LRU eviction and no disk or database writes. These are proposed limits, to tune with tests. Store source identity, resolved commit, bounded tree metadata and only requested manifests/licences in memory; drop on expiry, cancellation, process restart or memory pressure. Limit concurrent requests, stream with hard byte limits, cancel outdated queries, reject redirects outside approved GitHub hosts, and expose partial, offline and rate-limited source status. List paths first and fetch descriptions only for visible candidate results, explicitly distinguishing path search from exhaustive description search. Do not infer popularity or licences; use labelled curated suggestions only, and show unknown when unavailable.

The initial tree contains all repository paths: it is not a whole repository download, but it can still be megabytes. Show progress and communicate the scale. Validate untrusted paths, nested skill boundaries, modes, symlinks, size/file limits and manifest content, using existing package validation. Preview binds the source, commit, manifest and file-list hashes to a short-lived opaque session token. At assignment fetch only the selected package's pinned blobs, verify their Git blob identities and the previewed manifest, and include the applicable licence. If the commit, file set or content changes, or the token expires, require a fresh preview; never substitute HEAD. Display provenance and all files needed for an informed review, without executing scripts.

## Assignment and customization

Keep a role pack and immutable reviewed skill revision as the durable execution model. On confirmed Assign, create or reuse a personal skill revision with source commit, content hash, licence and reviewed marker tied to exactly the previewed files. Create a role with a readable title, generated valid unique name, minimal ROLE.md and pinned skill; show the target agent, scope and any name collision before mutation. Use assignment base revision for conflict detection and preserve room notes and permissions. Existing roles need no new skill import. An operation journal and DB transaction must ensure failed import, review, role creation or assignment does not leave an incorrectly assigned role; handle filesystem materialization and recovery explicitly. For Customize, create a clearly named editable draft only after the explicit action, and mark edits unreviewed until the final preview/review. Project scope is offered only where a project exists; roles remain personal under current decision #3 unless explicitly changed. Update indicators compare the pinned upstream commit or content and never change an assignment automatically.

Current `SkillSources.packageFiles` reads a pinned tree but downloads a complete codeload archive; simply reusing it violates the new no-bulk requirement. Reuse the existing import, revision, provenance, review, path validation and journal concepts, **not** that archive transport. Existing cached generation APIs are durable and must not be used for ephemeral search. Avoid mixing these paths or claiming existing local indexes are an on-the-fly solution.

## UI and migration

Open a focus-trapped, labelled modal from the member's Change role action; restore focus on close. Search roles and local skills immediately and public sources asynchronously. Show result source, partial coverage, preview commit, licence, files and loading/errors; announce updates without moving focus. Use arrows only within a correctly implemented listbox, Escape to close or cancel with unsaved-draft confirmation, and Enter only on an explicit focused action so selecting a result cannot silently assign it. The final Assign action itself is the explicit approval of the displayed pinned content and target; ensure this review satisfies the existing review gate. Manage library remains accessible, with existing workflows intact. Responsive single-pane navigation and keyboard/screen-reader tests are required.

Existing personal/project revisions, role identities, pins and assignments remain untouched; existing cached indices stay available until an explicit **Remove old fetched indexes** action, which states scope and size, excludes saved skills/roles, and is recoverable on failure. Do not delete source configuration or credentials. Confirm whether the lead wants a separate confirmation before destructive cache removal.

## Delivery and evidence

1. Prototype the modal with local roles/skills and the new direct assignment semantics behind a feature flag; no claim of complete public search or no-bulk behavior. Preserve the current accessible library while the flow is incomplete. Test conflict, permission and review gates, rollback and restart, keyboard/focus and existing assignments.
2. Resolve the search-coverage limitation with the lead before releasing public on-the-fly search. Implement bounded in-memory sessions and selected-file transport, then test no writes to DB, cache directories, temporary directories or logs during search/preview (snapshot filesystem and DB before/after, restart and assert); test expiry, eviction, cancellations, truncated trees, quotas, rate limits, offline and malicious archives/paths, stale preview and upstream changes. Test that a pinned assigned role works after a real restart with the source offline.
3. Add upstream-update checks and explicit legacy-index removal; test concurrent searches/removal and pinned content retention. Update the guide and requirements along with behavior.

An authenticated spike remains open pending an available token and permission; measure per-source request counts, rate headers and latency without logging credentials. Review this note and the complete-search tradeoff before implementation.

## Lead's direction and order

The lead chose progressive search: show path/name matches promptly, then stream descriptions into memory with visible progress and partial-results messaging. Remove old indexes only after one confirmation showing the size and explaining saved skills and roles are retained. Address request limits first, then the local role picker, remote search, and update/index management.

Cache resolved refs for a bounded period and cache immutable tree and manifest content by commit within a global memory budget; a finite cache may evict entries and must never promise they are kept forever. Coalesce concurrent requests, use ETags where supported, apply concurrency/byte caps, retain partial results, and show a meaningful reset time. GitHub's documentation specifically guarantees that **authenticated** conditional requests resulting in 304 do not count against the primary limit; do not assume the same for unauthenticated requests. Measure raw-host behavior without attempting to exceed its limits; credentials require permission and were unavailable in the first spike. Test ten openings using a counting fake server rather than spending the user's shared quota.
