# Keep rooms moving: continuation design

Status: proposal for review. This is the plan requested by the lead; the timer
defaults and automatic recovery behavior are proposed, not yet confirmed.

## Goal and boundaries

Recover from a lost handoff, an agent posting before continuing its own work,
and a timed-out or replaced session without asking the lead to nudge the room.
Automation only schedules a turn; it cannot send a message, approve a permission,
extend a run window, change a decision, execute code or bypass room rules. A
lead-directed or explicitly completed conversation must stay quiet.

## Explicit continuation contract

Add optional `next` to `post_message`: `{kind:'self'}`, `{kind:'agent',
agent_id}`, `{kind:'lead'}`, or `{kind:'done'}`. A structured discriminator
avoids collisions with agent names. `self` queues the sender; `agent` queues one
current room member; `lead` and `done` mean no automatic continuation from that
post. Validate target before committing the message. Treat mentions as the
existing routing contract: for `self`/`agent`, enqueue the explicit target plus
any other mentioned agents, deduplicated by room/member. Reject contradictory
`lead`/`done` combined with agent mentions instead of silently overriding either.
`@lead` alone suppresses watchdog scheduling even for an old client.

Existing clients may omit `next`; mentions continue to work unchanged. A post
without next or actionable mentions keeps the existing warning/one-call handoff
repair. For this legacy ambiguity, arm one bounded watchdog continuation for
the author, unless it explicitly addressed the lead; do not parse natural-language
claims such as “done”. Explain that behavior in join rules and the page. Clients
that know work is complete should explicitly choose `done`.

Store the continuation decision with the message and the resulting routing
receipt in the same SQLite transaction as post completion. Extend the retry
payload fingerprint and persisted `post_result_json` so a lost response returns
the original decision and cannot schedule a duplicate. Preserve current behavior
for old serialized receipts and bump the bridge protocol; advertise the feature
and an actionable connector-reload hint for older bridges. Update the MCP schema,
bridge serialization, shared protocol, API validation and compatibility tests.

`hand_off` remains a repair for the originating post. If the same target is
already queued by `next`/mention/watchdog, return the existing turn id; an
identical retry is idempotent. Reject stale sources and invalid/nonmember targets
as today. The page's manual Ask-to-continue action uses the same idempotent
routing transaction. A single source/target may produce at most one queued or
active continuation, including across a restart and a race between repair and
watchdog. Preserve the original message id as the continuation's source so the
agent receives a clear explanation without duplicating a conversation message.

## Heartbeats and timeout

An active turn gets a persisted `last_progress_at` initially set on activation.
`report_status(working)` from the same live session updates it transactionally;
timeout uses the later of activation and progress. Working is a heartbeat only
for that session's active turn, never a heartbeat for another turn. Repeated
heartbeats refresh the deadline but do not grow the activity feed every time.
An agent must call it periodically during genuinely ongoing work; connectivity
alone is not proof of work. Pending user permissions keep the existing timeout
exemption, and no heartbeat grants the requested permission. Pauses and breaks
continue to follow existing run-clock semantics.

On expiry, atomically mark the old turn skipped and schedule at most one recovery
turn for that turn's lineage, with a clear timeout notice. The recovery is queued
only for an eligible live session; if a session was replaced, deliver to its
current successor in the same room/member identity after it rejoins. Do not
replay a completed post. A stale old turn or old session cannot post or update
the new turn. If no eligible session exists, keep an explicit pending recovery
state and show “needs rejoin”; never create a loop of active turns. A recovery
turn that also times out does not get another timeout retry automatically.

## Watchdog

Persist one pending continuation per room, keyed to the latest relevant source
message and intended member, with `due_at`, reason, state and generation.
The default delay is **3 minutes**, configurable and bounded. A periodic tick
checks it inside a transaction immediately before enqueuing. Schedule only when:

- no active or queued turn exists, no fresh Working report or pending permission
  exists, and the source is still the latest routing-relevant event;
- the source did not declare `lead`/`done` or address the lead, and its intended
  target is still a member with a live, eligible session;
- the room and global state allow work: not paused, on break or archived, under
  the consecutive-agent-message limit, and the target's run window is active.

If paused/break/limit/window blocks execution, do not spend a nudge; show why
and re-evaluate when the block clears. Do not restart an ended session or extend
its window. A lead message, later agent message, manual handoff, valid explicit
queue, cancellation, member removal or new session state supersedes/revalidates
the pending plan atomically. Cancel remains effective across refresh and restart
for that source; a new source creates a new generation. Report working and fresh
permission waits suppress firing; no auto-resume while user approval is pending.

Persist nudge events and enforce a rolling **3 per hour per room** across all
automatic watchdog and timeout recoveries. When capped, stop automatic attempts
and show **Stuck · needs you**, with existing manual continuation controls. The
cap is not reset by restart. A watchdog-created turn that ends in a pass or times
out without progress must not be rearmed indefinitely from the same source.
Enable the watchdog by default to satisfy the lead’s request for automatic
progress, with a visible per-room off switch because continuations consume model
allowance. A disabled room never arms or fires a watchdog.

## Page and observability

Expose the persisted pending target, reason, server-calculated deadline, paused
reason and cap status in room state/events. Render **Auto-continue [agent] in
2:41 · Cancel** using server time for the countdown; at zero show checking until
the server reports the actual result. Cancel is a protected authenticated page
mutation with an idempotent generation/source token: a stale button cannot cancel
a newer plan. Show eligible explicit/manual actions when disabled, suspended or
capped. Log scheduled, cancelled, fired and suppressed/capped transitions once,
without logging message contents, credentials or permission details.

## Verification

- Service tests: `next`/mentions combinations, explicit lead/done, unknown
  target, old connector, replayed post, duplicate handoff/watchdog races, and
  unchanged R-H1 behavior. Cover restart/reopen with the same source receipt.
- Clock-controlled tests: progress refresh and stale heartbeat; one timeout
  retry; fresh versus stale Working; pending permission; source supersession;
  cancel and stale-cancel; all pause/break/streak/window gates; room rolling cap;
  multi-room isolation; durable cap after restart; eligible session replacement.
- Real-process tests start the server and actual bridge, then replay: unmentioned
  post with no continuation; `next:self` followed by a wait; and a timed-out or
  replaced session. Each permitted case resumes with no lead message, and each
  `lead`/`done`, pause, break and approval case remains quiet. Kill/restart the
  service between scheduling and firing to verify once-only behavior.
- Browser check countdown, cancel, blocked/capped state and reload on an isolated
  instance. Run the full check, request review, commit, then use the existing
  scoped push approval process. Never use the live room as the test fixture.

## Review additions

- Include `continuation: { reason, source_message_id, note }` in the returned
  turn for self, watchdog and timeout recovery, so the recipient understands why
  it was scheduled. Persist the source and reason with the queued turn.
- Join rules explain the four `next` choices in one line. Older clients retain
  compatibility and receive the existing reload guidance.
- Deliver in three reviewed, checked changes: explicit next and protocol; then
  heartbeat/timeout recovery; then watchdog, countdown and cancellation.
