# Skill-based assignments

Requirements: SA1–SA9 in [REQUIREMENTS.md](../../REQUIREMENTS.md) (draft at `2a282b6`). This note replaces the role model described in [role packs](role-packs-phase3.md), [role swap](role-swap.md), [role change notice](role-change-notice.md) and [custom role conversion](convert-custom-roles.md); those notes become historical when this ships.

## Summary

A room member's **assignment** is an ordered list of pinned skill revisions plus free-text **room instructions**. A skill can describe responsibilities ("you are the reviewer…"), a procedure, or both; it stays a standard Agent Skills folder. Roles disappear from the data model, the API, the page and the agent tools. Built-in PM, Implementer, Reviewer and QA become read-only built-in skills. A one-time upgrade converts every existing role assignment into an equivalent skill assignment without deleting room data.

## Data model

New and changed tables (one ordered migration; see [Upgrade](#upgrade)):

| Table / column                                                                                                                                                                        | Purpose                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `room_member_skills(room_id, agent_id, position, skill_id, skill_revision_id, delivery)`                                                                                              | Ordered pins. PK `(room_id, agent_id, position)`, `UNIQUE(room_id, agent_id, skill_id)`, FK to `room_members` and to `skill_revisions(skill_id, id)`. `delivery` is `full` (default) or `summary`; see [What agents receive](#what-agents-receive). |
| `room_members.legacy_role_revision_id` (nullable)                                                                                                                                     | Set by the upgrade for a converted member; cleared by the first assignment change afterwards. While set, replies keep the old `role` contract (see [Compatibility](#compatibility-with-connected-agents)).                                          |
| `room_members.role` → **`instructions`**                                                                                                                                              | Room instructions (free text, existing `MAX_ROLE_CHARS` bound). Absorbs old free-text roles and role-pack notes.                                                                                                                                    |
| `room_members.role_assignment_revision` → **`assignment_revision`**                                                                                                                   | Optimistic-concurrency token, bumped on every assignment change.                                                                                                                                                                                    |
| `room_members.delivered_role_identity/label` → **`delivered_assignment_json`**                                                                                                        | What the agent last received: `{instructions_hash, pins:[revision ids]}` plus labels, used to build change notices.                                                                                                                                 |
| `turns.role_envelope_json` → **`assignment_json`**; `swap_role_snapshot_json` → **`assignment_snapshot_json`**; drop `swap_role_text_snapshot`                                        | Per-turn delivered envelope and mid-turn snapshot (instructions now live inside the snapshot).                                                                                                                                                      |
| `skill_libraries.kind` adds `'builtin'`                                                                                                                                               | Read-only library seeded from `src/server/skills/builtin/`.                                                                                                                                                                                         |
| `legacy_role_revisions(role_revision_id PK, role_id, name, title, number, description, skill_id, skill_revision_id)` and `legacy_role_files(role_revision_id, path, blob_hash, mode)` | Every converted role revision, its converted skill, and its original files byte for byte (blobs stay in `skill_blobs`). Serve the old contract and `read_role_file`. Dropped together with the aliases.                                             |
| Dropped                                                                                                                                                                               | `role_libraries`, `roles`, `role_revisions`, `role_revision_files`, `role_revision_skills`, `room_member_roles`, `role_workspace_operations`, `converted_role_history`.                                                                             |

**Usage tracking.** `skill_usages` gains owner types `assignment` (owner `room:agent`, label "Room _name_ · _member_") and `turn` (an active turn's snapshot; removed when the turn ends). Trash stays blocked while any usage exists, so a pinned or in-flight revision can never disappear (SA7).

**Review.** `skill_reviews` is unchanged. Confirming an assignment or update inserts review rows for exactly the revisions shown (SA2/SA4). A pin to an unreviewed revision cannot be written without that confirmation.

## What agents receive

`wait_for_turn` and `join_room` return `assignment` (replacing `role`). On a turn where it changed, or on `read_assignment`, the full form:

```json
{
  "revision": 7,
  "changed": true,
  "notice": "Your skills changed: added test-plan rev 2; konfab-dev rev 1 → rev 2. Read them before continuing.",
  "precedence": "Room rules and the lead's instructions come first, then your room instructions, then your skills in the order listed. If two skills conflict, follow the earlier one and mention the conflict to the lead.",
  "instructions": "Work only in your own worktree.",
  "skills": [
    {
      "position": 1,
      "skill_id": "…",
      "revision_id": "…",
      "name": "konfab-dev",
      "number": 2,
      "description": "…",
      "skill_md": "---\nname: konfab-dev\n…",
      "files": ["SKILL.md", "checklist.md"]
    }
  ]
}
```

On later turns only `{revision, changed: false, reminder: "Your assignment is unchanged; call read_assignment to re-read it."}`.

- **Ordering and conflicts.** Lead and room rules > room instructions > skills in list order. The `precedence` sentence travels in every full envelope so the agent sees it. Order is chosen by the lead in the dialog; there is no separate "primary" flag, but the page labels position 1 "first" to encourage putting a responsibility skill there. Procedure-only skills are valid anywhere in the list.
- **Full or summary.** A pin with `delivery = full` carries its whole `SKILL.md` in `skill_md`; a `summary` pin carries name, description and file list plus "read SKILL.md with read_skill_file before relying on this skill" (exactly how role pins were delivered before). New pins default to `full`, since any skill may now carry responsibilities; the dialog has a per-pin **Send full text / Send summary** toggle. Other files are always read on demand with `read_skill_file`.
- **Size limit.** The full envelope must stay ≤ 64 KiB. One function computes it and is called by **every** transition that can change an envelope: assign, reorder, delivery toggle, instructions edit, skill update (member card and Update members…), Team swap/rotate/assign, Add agent, and the upgrade. User-initiated transitions are rejected with `413 assignment_too_large` before anything is written: "These skills total 71 KiB; agents can receive up to 64 KiB. Switch a skill to Send summary, remove one, or move long material out of SKILL.md into supporting files." The dialog shows a live meter from the same calculation and offers the summary toggle inline. The upgrade never rejects; see [Upgrade](#upgrade) step 4. Delivery never fails at turn time.
- **Notices** (SA5), computed from `delivered_assignment_json`: first assignment; removed ("hand over open work…", as today); instructions only; skills changed (lists added, removed, updated `name revA → revB`, and reordered); and the one-time upgrade notice (below).

### Agent tools

| Tool                    | Behaviour                                                                                                                                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_assignment` (new) | Full envelope; uses the turn snapshot when one exists.                                                                                                                                                                                                                                                                |
| `read_skill_file`       | Unchanged signature. Authorises against the snapshot's pin list when a snapshot exists, else `room_member_skills`. No longer joins role tables.                                                                                                                                                                       |
| `read_role`             | Deprecated. Returns the old role shape while the legacy contract applies (below), otherwise `{changed: true, notice: "Roles were replaced by skills; call read_assignment.", assignment: …}`.                                                                                                                         |
| `read_role_file`        | Deprecated. Serves the **original** role files byte for byte from `legacy_role_files` (so `ROLE.md` keeps its path and content). Authorised only if that role revision is in the caller's active-turn snapshot or its current legacy contract. Otherwise `410` "Roles were replaced by skills; call read_assignment." |

Both aliases and the legacy tables are removed in the release after next. Tool descriptions and the join prompt text say "skills" instead of "role".

### Compatibility with connected agents

A conversation that joined before the upgrade has cached the old tool list and has been reading `role` in `join_room`/`wait_for_turn` replies. For a converted member, until the lead changes that member's assignment (`legacy_role_revision_id` is set):

- replies contain the **old `role` field unchanged in shape and ids**: `{id, revision_id, name, number, changed, title, notes, role_md, skills:[{position, skill_id, skill_revision_id, name, description, reviewed, files}]}` on a full delivery and `{…, reminder}` otherwise, built from `legacy_role_revisions` / `legacy_role_files`, the pinned skill revisions and the room instructions as `notes`. The new `assignment` field is sent alongside it;
- `read_role`, `read_role_file` and `read_skill_file` behave exactly as before for those ids.

The first assignment change clears the legacy contract. That turn's reply carries `role: {changed: true, notice: "Roles were replaced by skills. Read the assignment field (or call read_assignment) from now on."}` plus the full `assignment`. A bridge-level contract test records today's `join_room`, `wait_for_turn`, `read_role`, `read_role_file` and `read_skill_file` replies for a fixture session, then replays the same calls against the upgraded server and asserts the old fields and ids are identical.

We don't promise that no reload is needed until the real connected-agent check in this room passes (Claude and Codex desktop apps). If it fails, the documented safe path is: **Take a break** in the room → reload the Konfab connector in each app → paste a fresh join prompt. Rooms, messages and the converted assignment are unaffected by that path.

## Mid-turn changes and swaps

Unchanged in principle from role swap: before the first change that affects a member with an active turn, store the full current envelope in `turns.assignment_snapshot_json` and add `turn` usages for its pins. `wait_for_turn` replay, `read_assignment` and `read_skill_file` during that turn use the snapshot; repeated changes never replace it. The next turn sees the new assignment with a notice.

**Team** (today's Team roles; header button renamed **Team**) moves complete bundles: pins _and_ room instructions. Room name, app identity, session and `can_edit` stay with the member (SA6). One transaction, guarded by every affected `assignment_revision`; a stale preview applies nothing. The handover system message wording changes from roles to skills. **Formats** schedule members and never read assignments; a regression test runs a full review Format with skill assignments.

## Assigning skills (page)

A clickable mockup goes to the lead before UI code is written.

- **Member card:** shows `konfab-dev rev 2 + 1 skill` (or "No skills"). One button, **Assign skills**, replaces Change role / Edit role. An **Update available** badge appears when any pin has a newer saved revision.
- **Assign skills dialog:** left, the existing picker search (My skills, Project, Built-in, Public) without roles; selecting a result previews it and offers **Add**. Right, the **Selected** list: drag or ↑/↓ to reorder, remove, revision and review state, Send full text / Send summary, "Update to rev N" per pin with a diff preview; below it the **room instructions** box and the size meter. Footer: **Assign N skills to _member_** with a summary of anything that will be marked reviewed.
- **Public skills:** **Add** only puts a _tentative_ entry `{source, path, commit}` into the dialog's selection, in page memory. Nothing is written while browsing, previewing or selecting, and **Cancel** or closing the dialog discards it, so the existing "nothing stored until you assign or customize" promise holds. On **Assign**, one request copies each tentative public skill (unchanged verification and provenance) and writes the assignment. Imports use the existing journaled import operations. If any step fails (verification, conflict, stale `base_revision`, size limit), the assignment is not written and every skill _created by this request_ is removed: database rows in the same transaction, folders by the import journal's rollback, which also runs at the next startup after a crash. Pre-existing skills are never touched by that cleanup.
- **Re-adding a public skill already in the library** (matched by source repository + path):
  - same commit → reuse the existing revision;
  - newer commit, and the local skill is an **unmodified upstream copy** (current revision's provenance is that source and the working folder has no draft) → import as a _new revision of the existing skill_ (no new folder; SA3);
  - newer commit, but the local skill has **local revisions or an unsaved draft** → never overwrite. The dialog explains "_name_ has local changes" and offers **Keep my version** (reuse the local revision) or **Add upstream as a separate skill** (suffixed name). A three-way merge is out of scope;
  - a _different_ skill with the same name → choice of suffixed name.
- **Library:** the Roles tab, Convert custom roles and role duplication go away. Each skill shows **Used by** (rooms and members, revision) and **Update members…** (SA4 skill-based entry point): lists every assignment pinned to an older revision across rooms, preselects none, previews the diff, and applies to the ticked ones in one transaction with per-assignment revision guards. Built-in skills are read-only with **Duplicate** to make an editable copy.
- **Add agent form:** chooses skills instead of a role, using the same selection component.

## API

Added: `GET|PUT /api/rooms/:id/members/:agentId/assignment` (PUT body `{base_revision, instructions, pins:[{skill_id, revision_id, delivery} | {public: {source, path, commit}, delivery}], review:[revision_id]}`; public entries are imported in the same request as described above), `GET /api/rooms/:id/members/:agentId/assignment/size` (meter for a draft selection), `POST /api/rooms/:id/assignments/reassign` (Team), `GET /api/skills/:id/usages`, `POST /api/skills/:id/update-assignments` (`{revision_id, targets:[{room_id, agent_id, base_revision}], review: true}`). Removed: every `/api/roles*` route and `role-pack`, `role-from-public`, `role-from-skill`, `role-updates`, `role-preview`, `roles/reassign`. `RoleLibrary` (`roles.ts`) and `role-files.ts` are deleted; assignment logic moves to a new `assignments.ts` (pins, envelope, snapshot, notices) next to `skills.ts`.

## Upgrade

### Backup

Before a database below the upgrade's version is migrated, `openDatabase` writes a consistent online snapshot with `VACUUM INTO '<home>/backups/konfab-pre-skills-v<from>.db'`. `VACUUM INTO` reads through SQLite's normal transaction view, so committed data still in `konfab.db-wal` is included; a plain file copy would miss it. The backup is written to a temporary name, then renamed, so a crash never leaves a half-written file under the final name. If that file already exists from an earlier failed start, it is reused, because the database is still at `<from>`. If the backup fails, the server does not migrate or start, and it reports why.

**Restore** (documented in the user guide): stop Konfab; move `konfab.db`, `konfab.db-wal` and `konfab.db-shm` aside; copy the backup to `konfab.db`; start the previous Konfab version. Folders written under `~/.konfab/skills/` by the upgrade are listed in the upgrade log and can be removed; nothing else on disk was changed.

### Conversion

Runs inside one migration step, so it either fully applies or leaves the database at the old version. The migration runner gains support for a function step (`(db) => void`) next to SQL strings, keeping the existing per-step transaction and foreign-key check. The step only reads and writes the database. Rerunning after a crash starts from scratch, because `user_version` was not advanced.

1. **Which role revisions convert:** the union of revisions referenced by `room_member_roles` **and** by every active turn's `role_envelope_json` and `swap_role_snapshot_json`. A mid-turn swap can leave a turn on an older role revision with different pins, and that revision is converted too. Each revision converts once, deduplicated across members and turns.
2. **Each converted revision becomes a personal skill revision.** `SKILL.md` = frontmatter `name` (role folder name, made a valid skill name) and `description` (role description) + the `ROLE.md` body unchanged; other role files are copied with the same paths. Blobs are reused from `skill_blobs`. Several revisions of the same role become revisions 1..n of one skill, in their original order. They are marked reviewed (a role is reviewed to be assigned), with provenance `{converted_from_role: {id, revision_id, title, number}}`. Built-in roles convert the same way into personal skills, so the agent keeps the exact text it had. `legacy_role_revisions` and `legacy_role_files` keep the original ids, metadata and files.
3. **Name collisions** with any existing skill row or folder in the personal library (checked with `existsSync` during the step) get a suffix (`-role`, then `-role-2`, …). Nothing is overwritten (SA8). The chosen names go into the upgrade log and a one-time page notice.
4. **The member's pins** = converted skill (`full`) first, then the role's pinned skill revisions in their order as `summary`. This is the same content the agent received before: `ROLE.md` in full plus a pin catalogue. A role with no skills yields a one-skill assignment. If the result still exceeds 64 KiB (possible only because room instructions are now inside the envelope), the converted skill is also switched to `summary`. The text is untouched, the agent reads it with `read_skill_file`, and the page flags "Delivered as summary to fit" so the lead can adjust it. Conversion never drops or rejects content.
5. **Room instructions** = old free-text role, then pack notes, joined by a blank line when both exist.
6. **Active turns:** each `role_envelope_json` / `swap_role_snapshot_json` is kept verbatim as the turn's legacy reply (so replay is byte-identical) and paired with an equivalent new-shape `assignment_snapshot_json` built from **that turn's own** role revision and pins, not the member's current assignment. `turn` usages are added for those pins. `read_skill_file` / `read_role_file` during the turn authorise against that snapshot.
7. **Legacy contract and notice:** `legacy_role_revision_id` is set for converted members. `delivered_assignment_json` is set to the converted assignment, so no change notice is generated. The next full delivery adds a one-time line: "Konfab replaced roles with skills. Your instructions are unchanged and are now the skill _name_. read_assignment returns them in the new form."
8. **Role tables are dropped.** Role folders on disk (`~/.konfab/roles/`) are left in place, untouched, and the guide says they can be deleted.

### Working folders

After the database step, a startup task writes each converted skill's working folder under `~/.konfab/skills/`. Per skill it is idempotent: it writes to a staging folder, journals it in `skill_import_operations`, and renames into place. Before writing, it checks the target:

- already exists with content equal to the current revision → done;
- missing → write it;
- exists with **different** content (something appeared since the database step) → don't overwrite; mark the skill "Working folder conflict" for the lead to resolve.

Leftover staging folders from a crash are cleaned up by the existing journal recovery at startup. Delivery reads blobs from the database, so a folder problem never affects agents.

**Failure and recovery.** If backup or conversion fails, the transaction rolls back, the server does not start, and it prints the cause plus the backup path. Fixing the cause and restarting retries from scratch. Connected bridges retry through the outage as today (S3).

## Tests

- Unit: envelope build/order/precedence text, full vs summary delivery, size calculation, notice variants (first, removed, instructions only, added/removed/updated/reordered, upgrade line), review recording on confirm, usage rows, trash protection with assignment and turn usages.
- Size validation on **every** transition: assign, reorder, delivery toggle, instructions edit, member-card update, Update members…, Team swap/rotate/assign, Add agent. Each over-limit attempt writes nothing.
- Integration: assign/update/reorder with stale revision conflicts. Public add: cancel leaves nothing; same commit reuses; newer commit on an unmodified copy adds a revision; newer commit with local revisions or a draft never overwrites; name collision; failure after import (stale base, size) removes only skills created by the request; crash between import and assignment recovered at startup. Skill-based update across two rooms with partial selection. Team swap/rotate/remove moves instructions but not `can_edit` or names. Full review Format with skill assignments.
- Backup: committed data left in the WAL (`wal_autocheckpoint = 0`) appears in the backup; an existing backup is reused after a failed start; a failed backup blocks migration; the restore procedure reopens the old data with the old schema.
- Upgrade, using a real fixture database built with the `2a282b6` schema, containing:
  - role pack + pinned skills + notes; role with no skills; built-in role; free-text role;
  - a name collision with an existing skill row and with a stray folder;
  - an assignment that exceeds 64 KiB once instructions move in;
  - an active turn whose **swap snapshot uses an older role revision and different pins than the current assignment**.

  Close, migrate, reopen, rebuild service and app. Then: replay `wait_for_turn` (byte-identical legacy reply); `read_role`, `read_role_file` (`ROLE.md` and a supporting file) and `read_skill_file` against that turn's snapshot; finish the turn; verify the next turn's reply (legacy `role` + `assignment` + upgrade line), preserved messages/decisions/sessions, and that the first assignment change clears the legacy contract. Repeat the step with an injected failure (database stays at the old version, retry succeeds). Kill the folder task mid-write and restart (idempotent, no overwrite on conflict).

- Bridge contract test: record old-version replies for a fixture session and assert identical fields and ids after the upgrade.
- Component and Playwright: Assign skills dialog (add, reorder, remove, update, size meter, room instructions), member card label and badge, Update members…, Team. Isolated instance check in light and dark mode.
- Remove role-only tests; port swap, notice and snapshot tests to assignments.

## Implementation order

One `feature/skill-assignment` branch, reviewed per step:

1. Schema, upgrade and `assignments.ts`, envelope, notices, agent tools and aliases, with the upgrade restart tests. Server keeps compiling with the old UI hidden behind the new API.
2. Mockup for lead approval, then the page: Assign skills dialog, card, Library changes, Team, Add agent form.
3. Docs: README, user guide, `docs/skills-and-roles.md` → `docs/skills.md`, requirements (mark superseded role IDs historical), handoff, design index.

## Out of scope

Auto-following newer revisions; deleting `~/.konfab/roles/`; changing the Agent Skills format; permissions of any kind.
