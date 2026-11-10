# Skill Library phase 2: public sources

Status: reviewed. Builds on the phase 1 local library and the measured source spike.
Phase 2a delivers sources, index, search, preview, offline/rate-limit state and
local UI polish. Phase 2b delivers Add, duplication, invalid drafts and import
recovery. Each phase is reviewed and committed separately; phase 3 connects
selected revisions to roles.

## Experience

Library has clearly selected **Mine**, **Project** and **Public** tabs, a search
field and Trash. Mine/Project rows show a Draft badge when the working package
differs from its current saved revision. Scan with bounded work and report a
refresh/error state rather than making an inaccessible or invalid draft disappear.
Untracked local folders show their validation diagnostic; valid ones offer Adopt,
and invalid ones do not offer Adopt in 2a. Phase 2b adds **Duplicate & fix** into
a separate local draft. The original folder is never modified automatically.

Public lists searchable cards with name, description, source repository,
revision/commit, licence when known and validation status. Source provenance
labels describe the repository (Vendor-maintained or Community); they do not
claim each package has been authored, reviewed or approved by that vendor.
Preview shows the exact pinned `SKILL.md`, full file list and sizes, licence,
provenance and diagnostics. Scripts are listed as files and never run by Konfab.

Search spans currently indexed metadata. During refresh show **Indexing N of M**
and explicitly say that search is incomplete until the source finishes. Offline
or rate-limited sources show the cached commit, last successful refresh and a
clear retry time when known; existing cached results remain usable. A failed
refresh never replaces a complete cache with an incomplete one.

**Add** copies a valid selected public package into Mine or the explicitly
configured Project library. **Duplicate & edit** gives a new name and opens a
local draft. An invalid package offers **Duplicate & fix**, not Add: it creates
a bounded, non-assignable draft without silently changing the original bytes;
the user fixes diagnostics and Save creates its first validated, unreviewed
revision. Preview/import do not mark anything reviewed. Collision errors give
the user a new-name choice; nothing overwrites a local folder or revision.

## Sources and refresh

Defaults are `anthropics/skills` and `openai/plugins`. Suggested, opt-in sources:
`vercel-labs/agent-skills`, `obra/superpowers`, `mattpocock/skills`,
`microsoft/skills` and `huggingface/skills`; display topics for the latter two.
Add source accepts a GitHub `owner/repository` and optional ref, not an arbitrary
network URL. Normalise/validate each component and show the resolved repository
and commit. User-added sources default to Community unless an exact maintained
repository is in the curated factual list; no organisation-wide trust inference.
Disable/remove a source without deleting already imported local revisions.

On first opening Public, show an explicit Fetch action for the default sources
with an approximate 30 MB download notice. No fetch runs merely by opening the
page; subsequent refreshes require the Refresh button.

Refresh resolves the selected ref to a full commit via the GitHub API. Cache the
response's ETag and use conditional requests on subsequent refreshes; a 304 keeps
the current commit. A new commit starts a separate staging generation. Retrieve
one pinned codeload archive and stream its entries to collect manifest metadata,
without extracting or executing files. Atomically promote that generation only
after successful complete indexing. Retain the previous complete generation on
network, parse, validation, limit or cancellation failure. The first refresh may
show partial indexing while it runs; cancel retains any earlier complete cache.

Use the MIT-licensed `tar-stream` streaming parser with a pinned lockfile and
licence review; the spike's `skills` npm package did not ship its documented
programmatic API. Do not import a private helper or shell out to a skill installer.
Validate archive structure, exactly one top-level root, entry types, paths and
duplicates; skip symlinks and special files with diagnostics. Do not trust tar
headers for expanded size: count actual decompressed bytes and abort immediately
at bounds. Preserve no unbounded temporary checkout. A single very large source
can fail clearly while other sources and existing cache continue to work.

In 2a, preview uses the manifest bytes and complete entry list from the pinned
archive generation, so preview remains available offline without a second
request. In 2b, selected import obtains a pinned Git tree and individual blobs.
Check the tree's `truncated` flag; on truncation walk non-recursive subtrees with
bounded depth/entries/requests, and fail visibly if any non-recursive tree is
itself truncated. Verify every downloaded Git blob against its tree object ID,
and ensure the archive metadata and package tree both belong to the same pinned
commit. Find the nearest applicable licence file, preserve its bytes and path or
record that licence is unknown; never fabricate a licence or infer authorship from
the source badge. Respect nested package boundaries and reject path escapes,
symlinks, hard links and duplicate paths. Cache selected blobs by commit and hash
so previously fetched previews/imports work offline, with clear missing-file
errors when a package was never fully cached.

## Bounds and persistence

Repository limits are independent of the phase 1 package limits. Initial
defaults, adjustable only via bounded server configuration: 50 MiB compressed,
100 MiB expanded, 100,000 archive entries, depth 32, 10,000 manifests and a
bounded elapsed time; a manifest itself cannot exceed the per-file limit. Keep
the existing 1,000 package entries, 2 MiB total and 512 KiB per-file limits.
Apply limits while streaming and before buffering; display precise errors rather
than truncating content. Rate-limit concurrent refreshes, cap total cache size,
with a default cap of 500 MiB (configurable), and evict unpinned remote cache
generations by least recent use, never local DB
revisions. Preview and import fail closed on hash mismatch or incomplete data.

Add migrations for `skill_sources` (stable id, owner/repo, ref, factual badge,
enabled), `source_generations` (source, commit, ref ETag, state, timestamps,
diagnostics and progress), `source_manifests` (generation, path, bounded metadata
and diagnostic), and content-addressed cache blobs for manifests/package files.
Source generation is immutable once complete; a source points at its promoted
generation. Persist progress sufficiently to show interrupted refresh after
restart, then restart or resume safely without presenting an incomplete index as
complete. Schema and migrations must preserve phase 1 data on a real reopen.

Phase 1's immutable revision blobs remain authoritative. Import stages bounded
verified files in Konfab-owned temporary storage, validates package metadata and
destination, then creates a local skill and first revision with source repo,
path, pinned commit, source hash and licence provenance. A DB/filesystem journal
or equivalent crash-safe transition must avoid partial tracked skills and never
overwrite an existing folder. If a crash leaves an untracked staging folder,
preserve it for recovery; clean up only task-owned, verified temporary files.
Support binary files and executable mode as data. A duplicate gets a new stable
skill identity, parent/source provenance and an unreviewed revision.

Drafts that fail validation need durable staging distinct from a valid skill
revision: add a bounded `skill_import_drafts` record and file references, scoped
to the selected library. Save validates and atomically promotes the draft into
the standard folder and first revision; discard deletes only its own staging
records/files. A draft cannot be reviewed, assigned or exposed as a valid skill.
Use optimistic draft tokens for concurrent editors; validation diagnostics name
the exact file/rule. Do not weaken standard validation to import a broken source.

## Network and credentials

Refresh/import is initiated by the lead from the local page; listing the local
library does not silently make network calls. Requests go only to `api.github.com`,
`github.com`/`codeload.github.com` as needed, with HTTPS and a strict allowlist;
reject redirects to other hosts, private/local addresses and credential-bearing
URLs. Do not fetch arbitrary URLs embedded in a repository. Avoid forwarding an
Authorization header across redirects or to the archive host. Use a bounded
request queue, rate-limit headers, backoff and cancellation. Anonymous 304s are
not assumed rate-free.

An optional `KONFAB_GITHUB_TOKEN` may raise API limits; it is read from the
server environment only, never persisted in SQLite, logs, page responses or
error text. The lead must explicitly enable authenticated access to GitHub
before the first request that sends it, in line with the room's permission rule;
anonymous public requests remain the default. Limit the token to the GitHub API
host and public-repository scope for this phase. Never pass the token to git,
subprocess arguments, telemetry or a redirect target. The design does not add
private-repository support or broaden the existing push-approval rules.

## Verification

- Deterministic fake HTTP fixtures: commit resolution, conditional refresh,
  304, pinned archive, partial indexing, cache promotion, offline cold/warm
  behavior, cancellation, rate limits and retry, redirects and credential
  stripping. Assert no unexpected network calls or secrets in logs/DB/responses.
- Archive/tree fixtures: traversal, duplicate paths, symlink/special entries,
  decompression and entry/depth limits, nested layouts, truncation fallback,
  hash mismatch, binary preservation, nearest licence and unavailable licence.
- Lifecycle tests: Add, duplicate, invalid draft/fix, collision, stale draft,
  review isolation, external changes, restart at each import boundary, and
  local/project isolation. Reopen a real DB and reconstruct service/app.
- Real-process tests use a controlled local fake source, not third-party network,
  including cache reopen and failed refresh preserving the last complete index.
  A separate opt-in public smoke check may repeat pinned sources from the spike.
- Browser-check source selection/search/progress, invalid local/public drafts,
  add/duplicate, offline/rate-limited states and personal/project tabs on an
  isolated instance. Run `npm run check`, update README/user guide/requirements,
  request code review, then commit and use scoped approval for any push.
