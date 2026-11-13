# Skill-based assignments

Requirements: SA1–SA9 in [REQUIREMENTS.md](../../REQUIREMENTS.md) (draft at `2a282b6`). This note replaces the role model described in [role packs](role-packs-phase3.md), [role swap](role-swap.md), [role change notice](role-change-notice.md) and [custom role conversion](convert-custom-roles.md); those notes become historical when this ships.

## Summary

A room member's **assignment** is an ordered list of pinned skill revisions plus free-text **room instructions**. A skill can describe responsibilities ("you are the reviewer…"), a procedure, or both; it stays a standard Agent Skills folder. Roles disappear from the data model, the API, the page and the agent tools. Built-in PM, Implementer, Reviewer and QA become read-only built-in skills. A one-time upgrade converts every existing role assignment into an equivalent skill assignment without deleting room data.

## Data model

New and changed tables (one ordered migration; see [Upgrade](#upgrade)):

| Table / column                                                                                                                                 | Purpose                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `room_member_skills(room_id, agent_id, position, skill_id, skill_revision_id)`                                                                 | Ordered pins. PK `(room_id, agent_id, position)`, `UNIQUE(room_id, agent_id, skill_id)`, FK to `room_members` and to `skill_revisions(skill_id, id)`.                   |
| `room_members.role` → **`instructions`**                                                                                                       | Room instructions (free text, existing `MAX_ROLE_CHARS` bound). Absorbs old free-text roles and role-pack notes.                                                        |
| `room_members.role_assignment_revision` → **`assignment_revision`**                                                                            | Optimistic-concurrency token, bumped on every assignment change.                                                                                                        |
| `room_members.delivered_role_identity/label` → **`delivered_assignment_json`**                                                                 | What the agent last received: `{instructions_hash, pins:[revision ids]}` plus labels, used to build change notices.                                                     |
| `turns.role_envelope_json` → **`assignment_json`**; `swap_role_snapshot_json` → **`assignment_snapshot_json`**; drop `swap_role_text_snapshot` | Per-turn delivered envelope and mid-turn snapshot (instructions now live inside the snapshot).                                                                          |
| `skill_libraries.kind` adds `'builtin'`                                                                                                        | Read-only library seeded from `src/server/skills/builtin/`.                                                                                                             |
| `legacy_role_revisions(role_revision_id PK, skill_id, skill_revision_id)`                                                                      | Maps converted role revisions for the `read_role_file` alias. Dropped one release later.                                                                                |
| Dropped                                                                                                                                        | `role_libraries`, `roles`, `role_revisions`, `role_revision_files`, `role_revision_skills`, `room_member_roles`, `role_workspace_operations`, `converted_role_history`. |

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
- **Full bodies.** Every pinned `SKILL.md` is delivered in full (roles used to deliver only `ROLE.md`, but any skill may now carry responsibilities). Other files are listed and read on demand with `read_skill_file`.
- **Size limit.** The full envelope must stay ≤ 64 KiB. The server computes it while validating an assignment, update or swap and rejects with `413 assignment_too_large`: "These skills total 71 KiB; agents can receive up to 64 KiB. Remove a skill or move long material out of SKILL.md into supporting files." The dialog shows a live size meter from the same calculation. Delivery never fails at turn time.
- **Notices** (SA5), computed from `delivered_assignment_json`: first assignment; removed ("hand over open work…", as today); instructions only; skills changed (lists added, removed, updated `name revA → revB`, and reordered); and the one-time upgrade notice (below).

### Agent tools

| Tool                    | Behaviour                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read_assignment` (new) | Full envelope; uses the turn snapshot when one exists.                                                                                                                                                                                     |
| `read_skill_file`       | Unchanged signature. Authorises against the snapshot's pin list when a snapshot exists, else `room_member_skills`. No longer joins role tables.                                                                                            |
| `read_role`             | Deprecated alias of `read_assignment`, so conversations that cached the old tool list keep working.                                                                                                                                        |
| `read_role_file`        | Deprecated alias: maps a converted `role_revision_id` via `legacy_role_revisions` and reads the converted skill (`ROLE.md` → `SKILL.md`, other paths unchanged). Unknown ids: `410` "Roles were replaced by skills; call read_assignment." |

Both aliases are removed in the release after next. Tool descriptions and the join prompt text say "skills" instead of "role".

## Mid-turn changes and swaps

Unchanged in principle from role swap: before the first change that affects a member with an active turn, store the full current envelope in `turns.assignment_snapshot_json` and add `turn` usages for its pins. `wait_for_turn` replay, `read_assignment` and `read_skill_file` during that turn use the snapshot; repeated changes never replace it. The next turn sees the new assignment with a notice.

**Team** (today's Team roles; header button renamed **Team**) moves complete bundles: pins _and_ room instructions. Room name, app identity, session and `can_edit` stay with the member (SA6). One transaction, guarded by every affected `assignment_revision`; a stale preview applies nothing. The handover system message wording changes from roles to skills. **Formats** schedule members and never read assignments; a regression test runs a full review Format with skill assignments.

## Assigning skills (page)

A clickable mockup goes to the lead before UI code is written.

- **Member card:** shows `konfab-dev rev 2 + 1 skill` (or "No skills"). One button, **Assign skills**, replaces Change role / Edit role. An **Update available** badge appears when any pin has a newer saved revision.
- **Assign skills dialog:** left, the existing picker search (My skills, Project, Built-in, Public) without roles; selecting a result previews it and offers **Add**. Right, the **Selected** list: drag or ↑/↓ to reorder, remove, revision and review state, "Update to rev N" per pin with a diff preview; below it the **room instructions** box and the size meter. Footer: **Assign N skills to _member_** with a summary of anything that will be marked reviewed.
- **Public skills:** **Add** copies the skill locally first (unchanged verification and provenance), then adds it to the selection. If the same source path is already in the library: same commit → reuse; newer commit → import as a _new revision of the existing skill_, not a new folder. Only a different skill with the same name gets a choice of suffixed name. This removes the "already exists" failures (SA3).
- **Library:** the Roles tab, Convert custom roles and role duplication go away. Each skill shows **Used by** (rooms and members, revision) and **Update members…** (SA4 skill-based entry point): lists every assignment pinned to an older revision across rooms, preselects none, previews the diff, and applies to the ticked ones in one transaction with per-assignment revision guards. Built-in skills are read-only with **Duplicate** to make an editable copy.
- **Add agent form:** chooses skills instead of a role, using the same selection component.

## API

Added: `GET|PUT /api/rooms/:id/members/:agentId/assignment` (PUT body `{base_revision, instructions, pins:[{skill_id, revision_id}], review:[revision_id]}`), `POST /api/rooms/:id/assignments/reassign` (Team), `GET /api/skills/:id/usages`, `POST /api/skills/:id/update-assignments` (`{revision_id, targets:[{room_id, agent_id, base_revision}], review: true}`), `POST /api/skills/import-public` (copy only, returns skill and revision ids). Removed: every `/api/roles*` route and `role-pack`, `role-from-public`, `role-from-skill`, `role-updates`, `role-preview`, `roles/reassign`. `RoleLibrary` (`roles.ts`) and `role-files.ts` are deleted; assignment logic moves to a new `assignments.ts` (pins, envelope, snapshot, notices) next to `skills.ts`.

## Upgrade

Runs once, inside the migration transaction, so it either fully applies or leaves the database untouched. The migration runner gains support for a function step (`(db) => void`) next to SQL strings, keeping the existing per-step transaction and foreign-key check. Before running it the server copies `konfab.db` to `konfab.db.pre-skills-<timestamp>`.

1. **Each assigned role revision becomes one personal skill** (deduplicated across members). `SKILL.md` = frontmatter `name` (role folder name, made a valid skill name) and `description` (role description) + the `ROLE.md` body unchanged; other role files are copied as-is. Blobs are reused from `skill_blobs`. Rev 1 is marked reviewed (the role was reviewed to be assigned) with provenance `{converted_from_role: {id, revision_id, title, number}}`. Built-in roles convert the same way into personal skills, so the agent keeps the exact text it had.
2. **Name collisions** with any existing skill row or folder in the personal library get a suffix (`-role`, then `-role-2`, …). Nothing is overwritten (SA8). The chosen names are listed in the upgrade log and a one-time page notice.
3. **The member's pins** = converted skill first, then the role's pinned skill revisions in their order. A role with no skills yields a one-skill assignment.
4. **Room instructions** = old free-text role, then pack notes, joined by a blank line when both exist.
5. **Active turns:** `role_envelope_json` and swap snapshots are rewritten into the new envelope shape (same content: converted skill + former pins + instructions), and `legacy_role_revisions` is filled so in-flight `read_role_file` calls still resolve. The turn continues unchanged.
6. **Notice:** `delivered_assignment_json` is set to the converted assignment and a flag queues a one-time notice on each converted member's next turn: "Konfab replaced roles with skills. Your instructions are unchanged and are now the skill _konfab-dev_. Use read_assignment instead of read_role."
7. **Role tables are dropped.** Role folders on disk (`~/.konfab/roles/`) are left in place, untouched, and the guide says they can be deleted.
8. **Working folders.** The migration only writes the database. After startup, a journaled task (the existing import-operation pattern) writes each converted skill's folder under `~/.konfab/skills/`. Delivery reads blobs from the database, so a failed folder write does not affect agents; the skill shows "Working folder missing — Restore" in the library.

**Failure and recovery.** If the migration throws, the transaction rolls back, the server does not start, and it prints the cause plus the backup path. Fixing the cause and restarting retries from scratch. Connected bridges retry through the outage as today (S3).

**Connected agents (SA9).** Verified by test, not assumed: an agent mid-turn finishes with its snapshot; its next `wait_for_turn` receives `assignment` with the upgrade notice; `read_role`/`read_role_file` keep working through the aliases. A connector reload is _not_ required; reloading only makes `read_assignment` visible. The handoff note will state this, and the real connected-agent check in this room confirms it.

## Tests

- Unit: envelope build/order/precedence text, size calculation and rejection, notice variants (first, removed, instructions only, added/removed/updated/reordered, upgrade), review recording on confirm, usage rows, trash protection with assignment and turn usages.
- Integration: assign/update/reorder with stale revision conflicts; public add same commit/newer commit/name collision; skill-based update across two rooms with partial selection; Team swap/rotate/remove moving instructions but not `can_edit` or names; full review Format with skill assignments.
- Upgrade, using a real fixture database built at `2a282b6`'s schema with: role pack + pinned skills + notes, role with no skills, built-in role, free-text role, name collision, an active turn with a snapshot. Close, migrate, reopen, rebuild service and app; then complete the active turn (including `read_role_file`), verify the next turn's envelope and notice, preserved messages/decisions/sessions, and folder materialisation. Plus a forced failure leaving the database at the old version.
- Component and Playwright: Assign skills dialog (add, reorder, remove, update, size meter, room instructions), member card label and badge, Update members…, Team. Isolated instance check in light and dark mode.
- Remove role-only tests; port swap, notice and snapshot tests to assignments.

## Implementation order

One `feature/skill-assignment` branch, reviewed per step:

1. Schema, upgrade and `assignments.ts`, envelope, notices, agent tools and aliases, with the upgrade restart tests. Server keeps compiling with the old UI hidden behind the new API.
2. Mockup for lead approval, then the page: Assign skills dialog, card, Library changes, Team, Add agent form.
3. Docs: README, user guide, `docs/skills-and-roles.md` → `docs/skills.md`, requirements (mark superseded role IDs historical), handoff, design index.

## Out of scope

Auto-following newer revisions; deleting `~/.konfab/roles/`; changing the Agent Skills format; permissions of any kind.
