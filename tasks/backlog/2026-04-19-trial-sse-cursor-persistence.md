# Trial SSE: persist `nextCursor` to DO storage across restarts

## Problem

`TrialEventBus` DO holds the in-memory event buffer and the
`nextCursor` (monotonic counter) in instance state only. When the DO
is evicted (memory pressure, deploy, host migration), both are lost.

Symptoms on reincarnation:
- New cursor sequence starts from 0, potentially colliding with
  cursors the client has already seen and ack'd
- Client's `Last-Event-ID` / resume cursor becomes meaningless
- In the worst case, the client re-receives old events with a lower
  cursor than it currently has, breaking ordering assumptions

This is **pre-existing** in the TRIAL_EVENT_BUS DO design; the SSE
contract fix on PR for `sam/pick-where-previous-session-01kpk2` does
not introduce or worsen it. Flagged by `cloudflare-specialist` review
as MEDIUM.

## Research findings

- `apps/api/src/durable-objects/trial-event-bus.ts` — confirm which
  fields live in-memory vs persisted
- The DO class is NOT marked `new_sqlite_classes` in wrangler.toml
  (line 157: `new_classes = ["TrialEventBus"]`). An intentional
  decision: "in-memory only — no SQLite storage needed for
  short-lived trial streams" — but the short-lived assumption breaks
  if the DO gets evicted mid-trial
- Trials live for up to `TRIAL_WORKSPACE_TTL_MS` (20 min default).
  DO eviction during a 20-min window is plausible on deploys.

## Options

1. **Switch to SQLite-backed DO.** Add a migration block promoting
   `TrialEventBus` to `new_sqlite_classes`. Persist `nextCursor` + a
   bounded ring buffer of recent events. Higher storage cost but
   crash-resistant.

2. **Seed cursor from wall-clock on re-init.** Use `Date.now()` as
   the monotonic base so reincarnation can't collide with past
   values. Doesn't preserve event replay but prevents cursor
   duplication.

3. **Accept the loss.** Document that mid-trial DO eviction will
   end the stream; force the client to restart from cursor 0.

Option 2 is the minimum-viable fix; option 1 is the correct fix.

## Implementation checklist (option 2 — cheap)

- [ ] On DO init, if `nextCursor` is not set, seed it with
      `Date.now()` (microsecond precision if possible)
- [ ] Document the behavior in the DO's header comment
- [ ] Unit test: simulate DO re-init, assert `nextCursor` > all
      previously-issued cursors

## Implementation checklist (option 1 — correct)

- [ ] Add a SQLite migration in wrangler.toml promoting the class
- [ ] Persist `nextCursor` + a bounded ring of recent events on
      every append
- [ ] Add a `getAfter(cursor)` method that loads from SQLite
- [ ] Migration considerations — existing DOs won't have SQLite
      bindings; plan for a zero-downtime migration

## Acceptance criteria

- DO re-incarnation does not produce duplicate cursors
- If option 1: events from before eviction are still replayable
  from storage

## References

- Pre-existing code: `apps/api/src/durable-objects/trial-event-bus.ts`
- wrangler.toml line 157
- `cloudflare-specialist` review on PR for branch
  `sam/pick-where-previous-session-01kpk2`
