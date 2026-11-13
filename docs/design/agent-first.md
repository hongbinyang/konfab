# Agents first: app and role per agent

**Status:** built (`POST /api/agents`, `web/src/AddAgentForm.tsx`). Supersedes the "group agents under their app" interface in [multiple agents per app](multi-agent-apps.md); the persistence and authentication parts of that note still apply.

## Model

An **agent** is the thing the lead adds. Every agent has two attributes:

- **App** (`agents.app_id` → `apps`): the desktop app that runs it, such as Claude or Codex. The app row is the connector install: it owns the join credential and the shared account allowance, so the per-app limit (`multi_agent.max_per_app`, default 4) stays per app.
- **Role** (`room_member_roles`): its responsibilities **in a room**. The same agent can be product manager in one room and developer in another, and [role swap](role-swap.md) works per room.

The database already stored this shape, so the change needed **no migration**. The lead chose to keep roles per room only; a per-agent _default_ role (one nullable column, applied when the agent joins a room) is deferred.

## Interface

- One **+ Add agent** button at the top of the Agents panel replaces the button under each app. It is disabled, with a tooltip, only when every app is full.
- The form asks for a display name, an agent ID (suggested from the name until edited; used for @mentions), the **App** (full apps disabled and shown as `n/max`), **Add to this room**, and an optional **Role in this room**.
- Cards are a single list. Each shows **App:** and **Role:** chips (`none` or `custom text` when there is no role pack). Change role and Team roles are unchanged.
- After adding, the next step is the card's **Copy join prompt** in a new conversation in that app.

## Role preview and confirmation

Decision #3 requires a preview and approval before a role is used. Choosing a role loads `GET /api/roles/:id` and shows that exact revision (title, revision number, ROLE.md and pinned skills with review state). Add stays disabled until the lead ticks "I reviewed this role (rev N)". Roles with unreviewed skills cannot be confirmed; the lead reviews them in Manage library or adds the agent without a role.

Preview requests carry a sequence number and late responses for an earlier choice are dropped. The confirmation stores the confirmed **revision ID**, not a flag, so a changed preview always clears it and the submitted revision is always the one previewed.

## API

`POST /api/agents {id, display_name, app_id, room_id?, role?: {role_id, role_revision_id, confirmed: true}}`

- `role` requires `room_id` (400) and `confirmed: true` (400).
- The agent insert, room membership and role assignment run in one transaction (`addAppAgent(..., afterAdd)`); an unknown revision or unreviewed skill rolls back the new agent. A `role_changed` event is logged.
- `POST /api/apps/:appId/agents` remains as a compatible alias without roles.

## Later

- **More app types** (for example Gemini or Grok) need a connector adapter: setup install target, bridge config format and join prompt. Only apps with an installed connector appear in the App list.
- **Several installs of one type** (two Claude accounts) would add `apps.kind`, filled with the current `id` for existing rows. Not needed yet.

## Tests

`tests/integration/api.test.ts` (confirmation required, rollback, role without a room, plain add), `tests/unit/roles.test.ts` (unreviewed skill rolls back the agent), `tests/web/add-agent-form.test.tsx` (ID suggestion, full apps, preview and confirmation, stale preview race, unreviewed skills, errors) and `tests/e2e/agents.spec.ts` (full flow in a real browser, light and dark).
