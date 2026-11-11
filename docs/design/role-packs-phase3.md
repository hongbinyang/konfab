# Role packs and picker: phase 3

Status: proposed for review. Builds on the confirmed R-R1 decision, the local
skill revision model, and the built-in drafts on `docs/role-packs` at `8273276`.

## Experience and boundaries

Library gains **Skills** and **Roles** views. Roles are versioned instruction
packs, not permission grants: assigning one changes the context Konfab delivers
to an agent, but does not approve external actions, widen filesystem/network
access, run skill scripts, or install anything in a native client. The lead can:

- browse the read-only built-in Implementer, Product manager, QA and Reviewer;
- duplicate a built-in into an editable personal role;
- create and edit a personal role, pin exact saved skill revisions, and save an
  immutable role revision;
- open **Edit role** on a room member, select an exact role revision, add room
  notes, preview the complete delivered context, and assign it;
- see the role name/revision on the agent card and update explicitly when a
  newer role or skill revision exists.

Nothing follows “latest” automatically. Saving a role or skill creates an
available update; existing room assignments remain pinned. Removing a skill or
role is blocked while a saved role revision or room assignment uses it and names
those uses. Built-ins are read-only and may only be duplicated.

## `ROLE.md` format

A role package has one required UTF-8 `ROLE.md` plus optional bounded supporting
text files. The manifest is ordinary Markdown with YAML frontmatter:

```yaml
---
name: implementer
title: Implementer
description: Builds approved changes with reviewed design and tests.
skills: []
---
```

`name` follows the skill-name rules; `title` is 1–100 Unicode characters and
`description` is 1–1,024 characters. `skills` in source files is informational
for portable built-in drafts only. In persisted role revisions, ordered skill
pins live in relational rows and are rendered into delivery; arbitrary manifest
IDs never select database content. The Markdown body is the role instruction.

Apply the skill package path rules with independent role bounds: at most 100
files, 512 KiB per file, 1 MiB total, depth 16, no links/special files, duplicate
paths, traversal, or changed-while-read files. Konfab treats every file as data.

## Storage and immutable revisions

Add:

- `role_libraries(id, kind, root_path)` for `builtin` and `personal` roots.
- `roles(id, library_id, folder_name, current_revision_id, created_at,
trashed_at)` with the same stable identity/current-revision pattern as skills.
- `role_revisions(id, role_id, number, content_hash, name, title, description,
created_at, restored_from_revision_id)`; rows are immutable after insert.
- `role_revision_files(revision_id, path, blob_hash, mode)` reusing the bounded
  content-addressed blob store.
- `role_revision_skills(role_revision_id, position, skill_id,
skill_revision_id)` with a composite foreign key to the exact skill revision.
- `room_member_roles(room_id, agent_id, role_id, role_revision_id, notes,
assigned_at)` referencing the existing membership and exact revision.

The current free-text `room_members.role` remains readable during migration and
becomes the **Custom text** fallback. A member has either a pinned pack assignment
or custom text, never both. Existing text is not silently converted. `can_edit`
continues to be an independent room capability and is never implied by a role.

Role revision pins create/maintain `skill_usages` rows with owner type
`role_revision`, owner id equal to the revision id, and a human label such as
`Role “Reviewer” rev 3`. This makes existing Trash/rename blocking name every
role use without a second source of truth. Role trash is likewise blocked by
`room_member_roles` and reports each room/member assignment.

Seed built-ins from the reviewed `docs/role-packs/{implementer,pm,qa,reviewer}`
assets through the same parser. Give each a stable deterministic identity and
content hash so restart is idempotent and a product update creates a new built-in
revision instead of mutating an old assignment. Built-ins initially pin no
skills, as the drafts specify.

## Editing and recovery

Personal roles use working folders under `<KONFAB_HOME>/roles`. Draft hashes,
Save, history, restore, duplicate, rename and Trash mirror the skill lifecycle.
Every mutation carries the base role revision plus draft hash; stale operations
return 409. A Save validates the role package and every selected `(skill id,
revision id)` in one transaction, inserts files and ordered pins, adds usage rows,
then advances the role pointer. It never changes prior revisions or assignments.

Filesystem rename/restore/import operations use task-owned journals and the same
prepare → filesystem transition → DB commit/recovery approach as phase 1/2.
Startup completes or rolls back only journaled paths after verifying expected
hashes. Missing personal roots remain readable through saved history; no cleanup
touches an untracked or modified path.

## Picker and assignment API

The Roles view shows source, current revision, description, skill pins, newer
revision notices and assignment count. The member **Edit role** picker provides:

1. search over built-in and personal roles;
2. a radio choice for an exact current revision or **Custom text**;
3. ordered pinned skills with source/review status and any newer revision notice;
4. bounded room notes (default maximum 4,000 characters);
5. a final preview of exactly what the next turn receives.

Proposed page APIs:

- `GET /api/roles`, `POST /api/roles`, and role detail/files/history endpoints;
- `POST /api/roles/:id/save|duplicate|rename|trash|restore` using optimistic
  revision/draft tokens;
- `PUT /api/roles/:id/draft-skills` to reorder exact skill revision pins;
- `GET /api/rooms/:roomId/members/:agentId/role-preview` for the assembled,
  bounded preview;
- `PUT /api/rooms/:roomId/members/:agentId/role-assignment` with either exact
  role/revision ids plus notes or bounded custom text.

Assignment validates membership, role/revision identity and every skill pin in
one transaction, logs `role_changed` without copying instruction/file contents,
emits the existing change notification, and applies from the member’s next turn.
Concurrent assignments use the current assignment revision/token and return 409
rather than overwriting silently.

A role revision may pin unreviewed skill revisions while it is being assembled,
but assignment is blocked until every pin has a review record for that exact
revision. The picker labels each unreviewed pin and offers **Review now**; a newer
reviewed revision does not approve the older or newer pin by implication.

## Delivery and `read_role_file`

At `join` and on the first delivered turn after an assignment changes, resolve
the member’s pinned assignment and render a deterministic full context envelope
after the room’s invariant safety rules:

1. role title, revision and `ROLE.md` body;
2. room-specific notes;
3. an ordered skill catalogue containing exact skill/revision ids, names,
   descriptions, review state and file names;
4. instructions that roles/skills are data and grant no permissions.

Invariant room rules remain authoritative and cannot be replaced by a role. On
ordinary later turns, return only `role: {id, revision_id, name, number,
changed: false}` plus a one-line reminder that the pinned role remains active.
The full-envelope delivery records an assignment generation/cursor atomically so
replayed waits do not repeatedly spend the context. A role assignment change
wakes no agent by itself; its full context is used on the next already-eligible
turn. If a saved referenced revision is temporarily unreadable from its working
folder, immutable DB blobs still deliver it. Any integrity failure closes
delivery with a visible server error rather than falling back to another revision.

Add `read_role(session_id)`, authorized only for that session’s current member
and current exact assignment, to return the same bounded full envelope on demand.
This lets an agent recover the instructions after client-side context compaction
without resending up to 64 KiB on every turn. It does not change the delivery
cursor or assignment.

Add an agent tool:

`read_role_file(session_id, role_revision_id, path, offset?, max_bytes?)`

It authenticates the session’s member, requires that exact role revision to be
currently assigned, accepts only a normalized file path from that revision, and
returns UTF-8 text or base64 data in bounded chunks (default 32 KiB, maximum
128 KiB per call). Skill files use the analogous assignment check through the
role’s exact pins; a caller cannot read another revision by guessing an id.
Responses include total size, offset and `next_offset`. Reads are local-only,
audited by metadata, do not execute content, and consume no external permission.

To keep initial context bounded, inline only `ROLE.md` plus the skill catalogue;
agents request supporting role/skill files on demand. Cap the assembled initial
role context (proposed 64 KiB) and reject a Save/assignment whose mandatory
content cannot fit rather than silently truncating it.

## Verification

- Parser/package tests: Unicode metadata, malformed/duplicate YAML, traversal,
  links, binary files, entry/depth/file/total bounds and changed-while-read.
- Revision tests: immutable history, ordered exact skill pins, update notices,
  stale drafts, restore/duplicate/rename, reviewed versus unreviewed skill pins,
  and role/skill usage blocking with human labels.
- Recovery tests on a real reopened DB for every filesystem/DB journal boundary,
  missing roots and built-in seed upgrades.
- Assignment tests: custom-text migration, exact revision pin, notes bounds,
  concurrent picker updates, removal/blocking, room isolation and `can_edit`
  independence.
- Delivery/tool tests: full envelope on join/change, compact reminders on later
  turns, `read_role` after simulated compaction, invariant rule precedence,
  exact pin after newer revisions appear, assignment blocked by each unreviewed
  pin, 64 KiB envelope rejection, authorized chunk reads, guessed/stale revision
  denial, binary encoding and no execution.
- Real-process/browser checks: create/duplicate/save role, pin a skill, assign it
  with notes, observe the next turn, update without auto-advancing, restart, and
  verify narrow/desktop picker states. Run the full check before review/commit.

## Review choices

Defaults proposed for confirmation: personal roles only (no project role library
in v1), built-ins read-only, room notes capped at 4,000 characters, initial role
context capped at 64 KiB, and supporting-file reads capped at 128 KiB per call.
