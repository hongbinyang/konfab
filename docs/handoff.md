# Handoff brief

Read this first when joining a new Konfab project room. It summarises where the project stands and how the team works, so a fresh room and fresh app conversations can continue without the old room's history. Updated on 2026-11-12 at main `5e564ea`. Newcomers: read the [README](../README.md), then the [user guide](user-guide.md), then this brief; developers continue with the [developer handoff](developer-handoff.md).

## How we work

- **The lead** decides. Agents propose; the lead confirms decisions in the room's **Decisions** panel.
- **Roles:** the PM agent (role `confab-pm`) writes requirements, reviews every change, checks UI changes visually in light and dark mode, merges and pushes. The developer agent (role `confab-dev`) writes a short design note for larger changes, implements on its own branch, and asks for review.
- **Flow for each feature:** requirement (with the lead's defaults stated) → design note in `docs/design/` → review → implementation with tests → review → merge into `main` → push. Small fixes skip the design note.
- **Mockups first** for new UI: a clickable mockup the lead approves before code is written.
- Follow [AGENTS.md](../AGENTS.md): own worktree and branch, `npm run check` before every commit, no agent or vendor names in commits or branches, real restart tests for restart behaviour.
- **Pushing:** take the advisory write lock `repo:/Users/yanghb/works/konfab#main`, request a scoped `code_push` approval (repository, branch, full base and head commits), verify origin and local match exactly, push fast-forward only, release the lock.
- Sharing code or designs with other agents in the room needs no permission request; outside recipients and pushes do.
- During long work, send a `report_status` (kind `working`) at the room's check-in interval (default 2 minutes); replies carry any queued lead mentions, which you can acknowledge in the status detail.
- Before merging UI changes, the reviewer checks them in an isolated instance (its own `KONFAB_HOME` and port, never the lead's data) in light and dark mode.

## Decisions to carry over

Re-propose these in the new room so the lead can confirm them there:

1. **Scoped push approvals:** pushes need a `code_push` approval for one repository, branch and commit range; check base and head immediately before pushing; fast-forward only.
2. **Skill library and role packs:** Agent Skills (`SKILL.md`) format unchanged; personal and project libraries; immutable saved revisions with review per revision; Konfab never runs scripts; roles grant no permissions.
3. **Choose a role window:** member card → **Change role** searches roles and personal, project and public skills; **Review & assign** or **Customize**; Library is **⚙ Manage library**.
4. **Public search:** names from GitHub file listings, descriptions streamed into memory only; nothing stored until assign or customize; GitHub request limits handled first.
5. **Team roles:** swap, rotate, assign or remove roles across any number of agents in one transaction; same-session role-change notices.
6. **Several agents per app:** named agents under one app credential; each session is bound to its agent.
7. **Write locks:** advisory; any room member with a live session can take one.
8. **Parallel lead mentions (experimental):** per-room setting; mentioned waiting agents answer immediately; busy agents get a queued note at their next Konfab call and check in at a per-room interval (default 2 minutes).
9. **Permanent room deletion:** lead only, archived rooms only, exact name confirmation.

## What exists today

Everything below is on `main`, reviewed and tested (316 tests and 7 smoke tests at `5e564ea`). The full list with IDs is in [REQUIREMENTS.md](../REQUIREMENTS.md) section 17. See the [user guide](user-guide.md) for how to use each part.

| Area             | Shipped                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup            | User-level connectors for both apps (`npm run setup`), migration from project `.mcp.json`, token rotation                                     |
| Roles and skills | Skill library, role packs, **Change role** picker with public search, filter location hints, Team roles, role-change notices, Manage library  |
| Team             | Several agents per app, review and debate **Formats**, advisory write locks                                                                   |
| Rooms            | Permanent deletion of archived rooms, parallel lead mentions (per-room setting, off by default), busy-agent check-in interval (default 2 min) |
| GitHub           | Optional token stored in macOS Keychain, **Check GitHub status**, request caching and rate-limit handling                                     |
| Quality of life  | Fast typing in long rooms, decision numbers on cards, reload notice after a server restart, inline checkboxes                                 |

Design notes for each feature are in [docs/design](design/).

## Open items

- **GitHub token:** the lead's stored token was last reported as rejected. Re-save it with `npm run setup -- --github-token` (paste the `github_pat_…` token at the "password data" prompts), restart, then **Check GitHub status**.
- **Parallel lead mentions:** measured in real use: a waiting agent's turn starts within milliseconds; a busy agent acknowledged a mention about 3 minutes later via its status. Next possible steps: reply-to links in the timeline, and deciding whether to turn the setting on by default.
- **Project folder:** set the room's project folder (room **Edit**) so project skills and the suggested lock key work.
- **Pending decisions** in the old room were never confirmed; re-propose the list above instead.

## Backlog (not started)

- **Continue in a new room:** one action that copies brief, members, roles and confirmed decisions into a new room and archives the old one.
- **Faster first public search:** more concurrent description reads, after measuring GitHub's raw host limits.
- **Smaller page bundle:** load the role picker and Team roles on demand.
- **Delete from the sidebar:** a ⋯ menu on archived rooms, since the delete button inside the room is easy to miss.
- From [REQUIREMENTS.md](../REQUIREMENTS.md) (LATER): scheduled rejoin (A14), per-agent modes (M4), Mac notifications (U7), threads and reactions (R11).
