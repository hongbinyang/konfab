# Agents first: app and skills per agent

**Status:** built (`POST /api/agents`, `web/src/AddAgentForm.tsx`). Supersedes the "group agents under their app" interface in [multiple agents per app](multi-agent-apps.md); the persistence and authentication parts of that note still apply. Updated for [skill-based assignments](skill-assignment.md).

## Model

An **agent** is the thing the lead adds. Every agent has two attributes:

- **App** (`agents.app_id` → `apps`): the desktop app that runs it, such as Claude or Codex. The app row is the connector install: it owns the join credential and the shared account allowance, so the per-app limit (`multi_agent.max_per_app`, default 4) stays per app.
- **Skills** (`room_member_skills` and `room_members.instructions`): its ordered skills and room instructions **in a room**. The same agent can be product manager in one room and developer in another, and Team moves skills between members per room.

## Interface

- One **+ Add agent** button at the top of the Agents panel. It is disabled, with a tooltip, only when every app is full.
- The form asks for a display name, an agent ID (suggested from the name until edited; used for @mentions), the **App** (full apps disabled and shown as `n/max`), **Add to this room**, an optional name in this room, and **Choose skills…**, which opens the [skill picker](skill-picker.md) in selection mode: nothing is saved until **Add agent**.
- Cards are a single list. Each shows **App:** and **Skills:** chips, **Assign skills** and **Copy join prompt**.
- After adding, the next step is the card's **Copy join prompt** in a new conversation in that app.

## API

`POST /api/agents {id, display_name, app_id, room_id?, room_name?, assignment?: {instructions, pins, review, confirmed: true}}`

- `assignment` requires `room_id` (400) and `confirmed: true` (400). Pins are local skill revisions or public skills to copy.
- The agent insert, room membership, any public-skill copies and the assignment run in one transaction (`addAppAgent(..., afterAdd)`); an unknown or unreviewed revision, a size over 64 KiB or a public-skill clash rolls back the new agent. A clash returns `{code, pin}` so the form can reopen the picker with the choice.

## Later

- **More app types** (for example Gemini or Grok) need a connector adapter: setup install target, bridge config format and join prompt. Only apps with an installed connector appear in the App list.
- **Several installs of one type** (two Claude accounts) would add `apps.kind`, filled with the current `id` for existing rows. Not needed yet.

## Tests

`tests/integration/api.test.ts` (confirmation required, rollback, skills without a room, plain add, public clash), `tests/web/add-agent-form.test.tsx` (ID suggestion, full apps, skills chosen in the picker, clash choices) and `tests/e2e/agents.spec.ts` (full flow in a real browser, light and dark).
