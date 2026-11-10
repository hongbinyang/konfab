# Skill Library phase 1: local lifecycle

Status: design for review. Implements the local portion of confirmed decision 3.
Remote catalogue/import is phase 2; role packs and agent delivery are phase 3.

## User behavior

The sidebar opens a Library page with a searchable Skills list, Mine/Project
scope selector and Trash view. Project scope requires selecting a room with an
explicit project folder. Create or Duplicate opens a draft. The editor shows
name, description, Markdown instructions with preview, package files, draft
status, provenance, licence and review status. Save revision freezes the whole
package; History can view old revisions or restore one as a new revision.

Preview and saving never mark a revision reviewed. A separate **Mark reviewed**
action approves the exact displayed immutable revision. A changed revision starts
unreviewed. No scripts execute. No native client directories are touched.

## Storage boundary

Add a dedicated `SkillLibrary` service in `src/server/domain/skills.ts`, with
package validation/file handling separated into `skill-files.ts`. Existing room
and turn behavior stays in `KonfabService`. Runtime injects a library home under
the same configured home as the database; tests inject temporary directories.
The page API uses the existing signed-in session, Host and Origin protections.
There are no new agent-accessible library endpoints in this phase.

Tables (additive migration):

- `skill_libraries(id, kind, root_path, created_at)`: personal or project, canonical
  absolute root unique. Personal root is `<KONFAB_HOME>/skills`; project root is
  `<explicit-project>/.konfab/skills`. Different rooms selecting the same canonical
  project share its library. Rooms retain a nullable `project_path` setting.
- `skills(id UUID, library_id, current_revision_id, created_at, trashed_at)`:
  stable identity, separate from a changeable display/package name.
- `skill_revisions(id UUID, skill_id, number, content_hash, name, description,
provenance_json, licence, created_at, restored_from_revision_id)`: immutable,
  numbered per skill; provenance includes source metadata and duplicate parent
  skill/revision when present. Unique `(skill_id, number)`; IDs remain distinct
  when restoring identical bytes.
- `skill_blobs(hash, content BLOB)` stores each unique file once; `skill_revision_files(revision_id, path, blob_hash, mode)`: full package,
  including binary assets and licence notices. Primary key `(revision_id,path)`.
- `skill_reviews(revision_id PRIMARY KEY, reviewed_at)`: explicit lead review,
  separate from immutable content. The current single-user app needs no invented
  identity system. Removing review can be offered through the same endpoint.
- `skill_usages(skill_id, revision_id, owner_type, owner_id, label)`: durable
  references reserved for role/assignment writers in phase 3; foreign keys enforce
  revision ownership. Deletion checks all live usages, not just current revision.

Working folders are `<root>/<skill-name>/`, containing `SKILL.md` and package
files. The folder name must match the manifest name. Stable skill IDs remain in
the database. Reject name collisions, while allowing matching names across scopes.
Discover valid on-disk folders without DB records as Untracked; Adopt snapshots
their current files as a first unreviewed revision, without overwriting them.
Never create identity/provenance sidecars inside the package.

## Project folder

Room settings gain **Project folder** (absolute path or clear). Resolve/validate an
existing directory and persist its canonical path; do not infer it from topic or
brief. Show the canonical path before/after save. Do not create an arbitrary
project directory. Create `.konfab/skills` only when the user first writes a skill.
Reject symlink library roots and unsafe root components when writing.

An unset project offers personal skills plus **Set project folder**. Missing,
inaccessible or moved roots show **Project folder unavailable**; immutable history
remains readable from the DB, but filesystem mutations fail clearly. Changing a
room's project path changes its library selection, never migrates old skills or
rewrites identity. Selecting a moved library must be an explicit future relink
operation rather than silently copying/merging libraries.

## Drafts, filesystem consistency and conflicts

Read working files when opening/refreshing a skill and before any mutation. Hash
sorted normalized paths, mode and exact file bytes with length framing; include
all files, not only `SKILL.md`. Compare to the saved revision to show **Draft**.
An invalid external edit stays editable with diagnostics; it cannot be saved as
a revision until fixed. Refresh detects external changes without a permanent
watcher. Displayed DB history does not depend on the working folder remaining.

Every draft write/save/delete/restore supplies both `base_revision_id` and
`base_draft_hash`. Re-read before mutation; mismatch returns 409 with current
revision/draft identifiers and preserves both sides. Draft writes use bounded
temporary files and atomic rename. No silent autosave of editor contents.

Save reads/validates a bounded snapshot, checks optimistic identifiers, inserts
files/revision and advances current revision in one DB transaction. The saved
snapshot is authoritative; a later filesystem edit becomes a new draft. Creating or duplicating uses an exclusively created name folder; failures remove
only newly created files. Rename uses an exclusive destination, conflict checks
and a durable recovery record: filesystem rename and SQLite cannot form one atomic
transaction. On restart reconcile the recorded old/new paths before further writes;
never overwrite a destination or silently discard either folder. History restore writes a draft using the same conflict
checks and then saves a new revision. It never mutates the historical revision.
If writing a draft fails, leave the existing immutable revision intact and return
an actionable error. A revision can be recovered even when its draft is missing.

Delete sets `trashed_at` and leaves the named folder intact (logical Trash), avoiding
a DB/filesystem move transaction. Trashed entries are excluded from ordinary lists
and cannot be edited or assigned. Trashed names remain reserved. Restore checks name collisions and filesystem
availability; no hard delete in v1; Empty Trash is planned for v1.1. Historical bytes and licences are retained.
Any live usage blocks Trash and returns its labels/links. Phase-1 tests seed the
usage boundary directly; phase 3 will wire actual role/room writes transactionally.

## Package validation and bounds

Defaults: 1,000 files and directories, 2 MiB total package bytes, 512 KiB per file, 32 path segments
and 512 UTF-8 bytes per relative path. Count bytes while reading, not after an
unbounded load. Reject absolute paths, empty/`.`/`..` segments, backslashes, NUL,
reserved internal temporary names, symlinks and special files. Root confinement
uses canonical directories and no-follow file opens, with regular-file checks;
reject linked parent components and hard-linked files on writes. Recheck file
identity during snapshotting and abort on concurrent changes. These are ordinary
local filesystem safeguards, not a sandbox against a hostile process running as
the same OS user.

`SKILL.md` must be UTF-8 with bounded YAML frontmatter. Use existing `yaml` with
duplicate-key/alias safeguards and no custom tags; require a mapping. Validate
Agent Skills name (1–64 Unicode lowercase alphanumeric characters/hyphens, no leading/trailing or
consecutive hyphens) and description (1–1,024 characters). Preserve extra standard
fields and instructions instead of regenerating away metadata. Metadata parsing
errors are explicit. Keep original licence files; duplicate adds provenance rather
than replacing upstream notices. Binary files are preserved/downloadable; only
valid text is edited inline. No execution permission is granted by import/save.

## Page API

Use `/api/library` routes with bounded Zod inputs and per-route body limits; no
global increase to existing request limits. Scope is personal or a room ID whose
project root the server resolves; clients cannot supply arbitrary file roots.

- `GET /api/library?room_id=&scope=&trash=`: list bounded metadata with draft,
  review and usage state; search name/description, no file bytes in lists.
- `POST /api/library/skills`: create validated initial package in selected scope.
- `GET /api/library/skills/:id`: current revision, draft metadata and file list.
- `GET/PUT /api/library/skills/:id/files`: bounded file read/write; writes include
  optimistic IDs. File deletion uses a dedicated request, with the same checks.
- `POST .../:id/duplicate`: snapshot chosen revision or explicit draft into a new
  skill, preserve provenance and notices, validate destination name/scope.
- `POST .../:id/save`: validate/snapshot draft; 409 for stale base.
- `GET .../:id/revisions` and `GET .../:id/revisions/:revisionId`: metadata/history;
  bounded file fetch selects exact revision. Never inline every binary in history.
- `POST .../:id/restore-revision`: restore as a new revision with conflict checks.
- `PUT .../:id/reviews/:revisionId`: explicitly mark/unmark that revision reviewed.
- `POST .../:id/trash` and `POST .../:id/restore`: logical lifecycle operations.

Rename changes manifest metadata in the editor and becomes effective on Save;
stable ID and provenance remain. File uploads use existing octet-stream support
with per-file bounds; text inputs and binary downloads have explicit encodings.
The browser offers **Copy folder path** for external editors; automatic editor
launch requires choosing an OS integration separately and is not a shell command
derived from a filename.

## Verification and delivery

Unit/integration tests cover whole-package hash stability and binary preservation,
manifest failures, bounds, path/symlink escapes, external invalid/valid drafts,
stale editor conflict, save/rename/duplicate provenance, review isolation, history
restore, Trash usages/name conflicts and missing project roots. Reopen an actual
temporary DB and rebuild service/app to prove revisions/files/reviews/usages and
project association survive restart. Page API tests exercise signed-out rejection,
request protection, bounded uploads/downloads and 409 responses.

Browser-check the Library navigation, personal/project selection, create/edit/save,
external-draft conflict, history, review and Trash on an isolated test instance.
Run `npm run check`, update README/user guide/requirements, obtain code review,
commit on `feature/skill-library`, then request exact scoped push approval. No
remote requests or new runtime dependencies are needed for this phase.
