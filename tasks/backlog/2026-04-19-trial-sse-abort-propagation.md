# Trial SSE: propagate client aborts into `TRIAL_EVENT_BUS.fetch('/poll')`

## Problem

In `apps/api/src/routes/trial/events.ts`, the SSE handler calls
`env.TRIAL_EVENT_BUS.get(id).fetch('/poll?cursor=...&timeout=...')`
inside `ReadableStream.start()`. The `/poll` endpoint long-polls for up
to `TRIAL_SSE_POLL_TIMEOUT_MS` (default 30s on staging, 500ms in the
workers test config).

When the browser closes the EventSource (user navigates away, tab
closes), `ReadableStream.cancel()` fires on the Worker side — but the
currently in-flight `busStub.fetch('/poll')` is NOT aborted. It
continues running until the DO's poll timeout elapses, then resolves
with an empty event list that gets discarded.

Impact:
- Each disconnected client keeps one DO thread blocked for up to
  `TRIAL_SSE_POLL_TIMEOUT_MS` after disconnect.
- Under bursty trial traffic this can pin DO isolates for no reason.
- Cost in CPU-seconds that never produced any user-visible work.

This is a **pre-existing** architectural issue — my SSE-contract fix
(unnamed frames) did not introduce it. Flagged by
`cloudflare-specialist` review on PR for `sam/pick-where-previous-session-01kpk2`
as HIGH and scope-expansion-out-of-band for the fix PR.

## Research findings

- `apps/api/src/routes/trial/events.ts` creates the
  `ReadableStream` and holds a closure over the DO stub. The `cancel()`
  callback would need to surface an `AbortSignal` into the active
  `busStub.fetch(...)` call.
- `busStub.fetch()` accepts a `RequestInit` with `signal`. The DO's
  `/poll` handler already races the wait-queue against its `timeoutMs`
  timer. If the DO side also respects the client abort, the long-poll
  can exit early.
- `apps/api/src/durable-objects/trial-event-bus.ts` holds an internal
  promise queue keyed on cursor; confirm an aborted fetch cleanly
  removes its waiter instead of leaking.

## Implementation checklist

- [ ] Create an `AbortController` per `start()` invocation
- [ ] Pass `controller.signal` into `busStub.fetch('/poll', { signal })`
- [ ] Wire `cancel()` to call `controller.abort()`
- [ ] In `TrialEventBus` DO `/poll` handler, also listen for the
      incoming request's abort signal and remove the waiter from the
      queue on abort (no dangling promise resolution)
- [ ] Unit test: open stream, simulate client cancel mid-long-poll,
      assert the DO waiter map is empty after abort
- [ ] Consider whether the same pattern is needed for the heartbeat
      loop's setTimeout — `cancel()` already should clear it but verify

## Acceptance criteria

- Closing the browser tab mid-long-poll no longer keeps the DO thread
  blocked for the remaining timeout window
- Existing unit/capability tests still pass
- Staging verification: open SSE, close tab, confirm DO poll count
  (via logs or a test probe) drops immediately

## References

- Post-mortem: `docs/notes/2026-04-19-trial-sse-named-events-postmortem.md`
- Pre-existing code: `apps/api/src/routes/trial/events.ts`
- `cloudflare-specialist` review on PR for branch
  `sam/pick-where-previous-session-01kpk2`
