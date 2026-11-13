# Listening status and recovery

**Status:** built (`contactStale()` in the service, `web/src/ContactNotice.tsx`). Follows the 2026-11-12 incident where an agent's conversation stopped polling and the lead's `@all` waited unanswered.

## What happened

The agent's last `wait_for_turn` was at about 17:00:00. The lead posted `@all` at 17:01:36, and the server logged `contact_lost` at 17:01:56. Detection worked. The gaps were:

- **Prevention:** the agent ended its conversation on `idle` despite the tool description ("call this again right away").
- **Wording:** the card said **Not responding** with "It may be out of allowance, so check its app". That blames allowance, gives no time and offers no recovery step.
- **Timing at mention:** the lead got no signal when they mentioned an agent that wasn't listening.

## Signals Konfab has today

| Signal                                                                  | Where                                                       | Notes                                                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions.last_call_at`                                                 | Every bridge call (`wait`, posts, `report_status`, locks …) | The only proof of contact. Persisted across restarts.                                                                                   |
| `sessions.contact_lost_at` + `contact_lost` / `contact_restored` events | Server tick                                                 | Set when there's no active turn, no break, the run window is active, and `now - last_call_at > wait_timeout + 60 s` (110 s by default). |
| `isLive()` → card state `not_responding`                                | `agentState()`                                              | A **different** threshold: `now - last_call_at > 90 s` (`DEFAULT_LIVE_WINDOW_MS`).                                                      |
| Active turn                                                             | `turns.state = 'active'`                                    | A working agent doesn't poll, so it's excluded from contact loss (the turn timeout covers it).                                          |
| Working outside a turn                                                  | `sessions.working_detail`, `working_updated_at`             | Updated by `report_status`, which also updates `last_call_at`. Agents are asked to report every check-in interval (default **2 min**).  |
| Pause, break, run window                                                | Room and session fields                                     | Paused rooms still answer `wait` with `idle`, so agents keep polling. Breaks and ended windows end or exclude the session.              |

## Problems found

1. **Two thresholds:** the card uses 90 s and the event uses 110 s. They should be one rule.
2. **False positive for busy agents:** an agent working outside a turn reports every 2 minutes, but `agentState()` flags it **Not responding** after 90 s without a call. The card then shows "Not responding" between check-ins.
3. **Server restart:** after a restart, every `last_call_at` is from before the downtime. Agents look lost until their bridge's next call, even though they reconnect on their own.
4. **Misleading copy:** the card blames allowance, gives no last-contact time, and has no recovery button next to the warning.
5. **Prevention:** the idle reply carries no instruction. Only the tool description does, and that's easy to lose in a long conversation.

## Proposal

### One contact rule (server)

`contactStale(session)` is true when **all** of these hold:

- the session is active, the run window is active, the room isn't on break, and the agent has **no active turn**;
- `now - max(last_call_at, server_started_at) > limit`, where `limit` is:
  - **waiting** agents: `wait_timeout + 60 s` (110 s by default, same as today's event);
  - agents with a **working status**: `2 × check-in interval + 60 s` (5 min by default), so a 2-minute reporter is never flagged between reports.

`agentState()` and the tick both use it. `isLive()` (90 s) is left as is for turn routing (who to skip, handoffs, automatic continuations); changing routing is a separate decision. The restart grace comes from `server_started_at`, kept in memory and set at boot.

### Card wording (page)

| State                    | Card                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale while waiting      | **No contact · last 5:00 PM** (amber), then "Its conversation may have stopped. Paste the rejoin prompt in that app." with **Copy rejoin prompt** |
| Stale while working      | **Working · no update since 5:00 PM** (amber), then the same hint and button                                                                      |
| Mention queued and stale | Adds "Your mention from 5:01 PM is waiting"                                                                                                       |

The wording describes **last contact**, not "quit" or "out of allowance", because Konfab can't know why a conversation stopped. Allowance stays a separate state, set only when the agent reports `low_allowance` or `out_of_allowance`. **Copy rejoin prompt** reuses the existing join prompt.

### Notice at mention time

`POST /api/rooms/:id/messages` returns `unreachable: [{agent_id, last_contact_at}]` for mentioned agents (including via `@all`) that are stale or not joined. The page shows a small note under the message ("Claude has had no contact since 5:00 PM · Copy rejoin prompt"). It isn't stored as a message, so it doesn't spam the room or the agents.

### Prevention (bridge)

The idle reply gains `next: "Call wait_for_turn again now. Keep this conversation in the loop until the status is closed or replaced, or the lead says stop."` The join prompt gets the same sentence. This is text only; the tool behaves the same.

## Out of scope

- Restarting a desktop conversation. Only the app can do that.
- Push notifications to the lead's desktop.

## Tests

- **Unit** (fake clock): one rule for the waiting and working limits; no flag between 2-minute reports; restart grace; pause doesn't flag an agent that keeps polling; break and ended window excluded; an active turn excluded; `contact_restored` on the next call.
- **Integration:** a message API response lists unreachable mentioned agents (direct and `@all`), and lists nothing when everyone is in contact; the idle reply includes `next`.
- **Component:** card wording for each state, plus a Copy rejoin prompt button that copies the agent's prompt; the mention note renders and is dismissible.
- **Browser** (Playwright, light and dark): mentioning an agent that hasn't joined shows the note with **Copy join prompt**, and **Dismiss** clears it. The stale card itself needs real time to pass, so it's covered by unit and component tests and checked by hand with `wait_timeout_seconds: 5`.
