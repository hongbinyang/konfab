# Room names for agents

Implements AN1–AN6 in [REQUIREMENTS.md](../../REQUIREMENTS.md) (section 17, "Room agent names"). AN7 is out of scope.

The lead names an agent when adding it to a room, for example "A". From then on, the lead and the other agents mention it as `@A`. The name can be changed or cleared until the agent first joins that room; after that it is fixed. Agent IDs, sessions, tokens and stored message recipients do not change. This note relaxes one rule from [multiple agents per app](multi-agent-apps.md): agent IDs are no longer the only mention targets.

## Data (AN1, AN4)

- A migration adds the table `room_agent_names(room_id, agent_id, name, created_at, updated_at)`.
  - The primary key is `(room_id, agent_id)`, with foreign keys to rooms and agents.
  - Names are kept in their own table, not in `room_members`, because `replaceMembers` deletes the member row when a member is removed. When that agent is added back, its name returns (AN4).
  - **Uniqueness applies only among current members.** A former member's name is not reserved, so the lead can give it to another agent. The validator enforces this inside the write transaction. There is a plain, non-unique index on `(room_id, lower(name))` for lookups. A database unique index would wrongly block reuse of a departed member's name. If the former member is added back while someone else holds its name, the add is rejected (see below).
- **`name`** must match the existing mention syntax, `^[A-Za-z][A-Za-z0-9_-]{0,31}$` (AN2).
  - It is stored as typed, for example "A" or "Reviewer-2", and matched ignoring case.
  - A name that doesn't match is rejected with a message such as "Names start with a letter and use letters, digits, - or _ (32 at most), so they can be typed after @."
- **Fixed after first join (AN1):** a name is fixed once any `sessions` row exists for that room and agent. Sessions are never deleted, so this check needs no extra column. It also covers agents that joined before this feature shipped: they keep their display name and ID in those rooms.
- Rooms start with no rows, so existing behaviour does not change (AN5).

## Setting a name (AN1, AN2, AN4)

The name can be set in three places. All of them go through one validator, inside the same transaction as the write.

1. **Add agent form:** a new optional field, **Name in this room**, shown when "Add to this room" is ticked. `POST /api/agents` accepts `room_name`.
2. **Member card, before the agent first joins:** an inline **Name in this room** form. It calls `PUT /api/rooms/:id/members/:agentId/name` with body `{name}`. `DELETE` on the same path clears the name. This form is how the lead names a default agent or an existing agent that is being added to a new room.
3. **Team roles / Agents member picker:** no name field. Adding a member here only runs the conflict check described below.

The validator rejects:

- an archived room (409 `room_archived`)
- an agent that has already joined this room (409 `name_fixed`, message "Names are fixed once the agent joins this room")
- `lead` or `all` (400 `name_reserved`)
- a name that matches, ignoring case, another current member's name or ID (409 `name_conflict`, message "@b is Codex's name in this room. Choose another name."). An agent's own ID is allowed as its name.

**Adding a member** (through the Agents picker, Add agent or Team roles) runs the same conflict check in both directions:

- the new agent's ID against existing members' names
- the new agent's retained name against existing members' IDs and names

On a conflict the add is rejected with 409 `name_conflict`, and the message says which name clashes (AN4). Only page (lead) routes write names; no bridge tool can (AN1).

## Mention resolution (AN3, AN5)

`parseMentions` stays as it is. A new function, `resolveMentionTokens(roomId, tokens)`, returns member agent IDs. Each lowercased token is checked in this order:

1. `lead` and `all`
2. member room names
3. member IDs, which remain aliases

The validator guarantees that a token can never match two members.

All routing paths use this function:

- lead posts (`postUserMessage`), including the parallel lead-mention queue
- agent posts (`resolveMentions`)
- `next: {kind: "agent", agent_id}`, which accepts a name or an ID and is stored as the ID
- `addressed_to` in lead-message excerpts
- the composer's not-listening contact notice

### Stored mentions and message metadata

- **`messages.mentions` is left as it is.** It stores delivery targets: for a lead post, every member when the post has no mentions; for an agent post, the resolved member IDs plus `lead` when it is mentioned (`@all` expands to every member and `lead`). Its current consumers keep their meaning: attention counts, the latest-message routing check, and continuations.
- A migration adds a nullable column, **`messages.mentioned`**. It holds JSON with the post's **explicit** mentions, in the order written and normalized when the post is made:
  - A token that matched a member's name or ID is stored as that agent's ID.
  - `lead` and `all` are stored as they are.
  - A token that matched nothing is stored lowercased, as the view does today.
  - A post without mentions stores `[]`.
- **The message view's `mentions` field** (page, `join_room`, `wait_for_turn`, `read_history`) returns `mentioned` when it is set. Otherwise it falls back to today's `parseMentions(body)`. Rows from before the migration have `NULL`. For those, the fallback gives exactly the old result, because before this feature every routable token was already an agent ID. No backfill is needed.
- **Effect:** `@A` written to claude shows `mentions: ["claude"]` both now and after a later rename, and `@all` stays `["all"]`. The field keeps its meaning ("who was explicitly mentioned") and its shape (an array of strings). Message text is never rewritten (AN5).
- `addressed_to` in lead-message excerpts reads the same field, minus `lead`.

## Agents (AN2)

- `join_room` and `wait_for_turn` keep `members` (a list of IDs) for compatibility. They add `member_names: [{id, name}]`, where `name` is the room name or, if there is none, the ID.
- The turn rules gain one line, generated per room: `Members: @A (claude), @B (codex). Mention members by these names; IDs also work.`
- Names can only change before an agent joins, so every agent already in a room sees a stable list. A newly named member appears in the list on the next turn or wait result.
- Bridge tool descriptions say `next.agent_id` may be a member name. Old bridges keep working because request shapes are unchanged.

## Page (AN2, AN5, AN6)

- The room state API adds `room_name` (nullable) and `name_fixed` (boolean) to each member. It also includes the names of former members whose messages are still visible.
- The client derives `label = room_name ?? display_name` and `mention = room_name ?? id`.
- In a room, every place that shows `display_name` uses `label` (AN5):
  - message senders
  - cards and status lines
  - contact notices
  - Team roles and format pickers
  - continuation buttons

  The sidebar, Manage agent and other rooms keep the display name.

- **Card heading:** `A @A`, followed by the App chip.
  - The agent ID and "Default agent for Claude (used when join_room has no `as`)" move to the heading's tooltip and accessible description (AN6).
  - The `· default` text is removed.
- **Before first join:** the card shows **Name in this room** with Save and Clear. Errors appear inline under the field.
- **After first join:** the name is shown with a small "Fixed" note, and its tooltip explains that names are fixed once the agent joins this room (AN2). Archived rooms show no form.
- **Composer hint:** "Mention: @A, @B, @all".

The clickable mockup is [mockups/agent-names.html](mockups/agent-names.html). Open it in a browser; a button switches between the light and dark themes.

## Tests

- **Unit:** name validation (syntax, length, reserved names, case); resolution order and ID aliases.
- **Service:**
  - `@a` and `@A` give claude a turn, and `@claude` still does
  - an agent's post with `@B` hands off
  - `next.agent_id` given as a name
  - parallel mention by name
  - `name_fixed` after a join, including a session from before the feature
  - conflicts on rename and on add, in both directions
  - removing and re-adding a member keeps its name
  - name reuse:
    - remove A, then give "A" to B: this succeeds
    - re-add the old A: rejected with `name_conflict`, which names B
  - `messages.mentions` keeps its current values:
    - an unaddressed lead post still lists every member
    - an agent post's `@all` still expands to every member plus `lead`
  - `mentioned`:
    - `@A` is stored as `claude`
    - `@all` stays `all`
    - an unknown token is kept as written
    - an unaddressed post stores `[]`
    - it is unchanged after clearing a name before a later join
  - legacy rows with `NULL` `mentioned` return the same `mentions` as before the migration
  - an archived room is rejected
  - another room is unaffected
  - `member_names` and the rules line appear in join and turn results
- **Restart:** upgrade a database from the previous schema version, then reopen the real database, service and app.
  - Names, the fixed state and `mentioned` survive.
  - Rooms and messages from before the feature behave and display as they do today.
- **API:**
  - `PUT` and `DELETE` on the name: success, reserved, invalid, conflict, fixed, archived, unknown agent
  - `POST /api/agents` with `room_name`, including a conflict
- **Component:**
  - the card shows the name and mention, with no "· default"
  - the name form works before join; after join it is read-only with a "Fixed" note
  - errors appear inline
  - message senders and pickers use the room name
- **Playwright:** add an agent named "A", join it with a scripted agent, and post `@a hi`. Only that agent is queued, the label appears on the message and the card, and the form is fixed. Check the light and dark themes.
- **Docs:**
  - user guide sections 3 and 9
  - move REQUIREMENTS AN1–AN6 from "Proposed" to shipped
  - add an entry to the design index
