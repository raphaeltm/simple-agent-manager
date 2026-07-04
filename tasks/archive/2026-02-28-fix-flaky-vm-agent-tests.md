# Fix Flaky VM Agent Tests

**Created**: 2026-02-28
**Status**: Resolved
**Priority**: Medium
**Estimated Effort**: Medium

## Resolution

Resolved by `tasks/active/2026-07-04-fix-flaky-tests-at-root.md`.
The original backlog root-cause theory was corrected: replay buffer ingestion is
synchronous, while the flaky loss happened on delivery when replay could block on
the viewer send buffer under CI scheduler pressure. The test now sizes
`ViewerSendBuffer` above the replay volume and reads concurrently with attach, with
no `time.Sleep` synchronization and no retry mechanism.

## Problem

`TestSessionHost_ReplayDoesNotDropMessages` in `packages/vm-agent/internal/acp/session_host_test.go` is a known flaky test. It intermittently fails in CI with messages like:

```
session_host_test.go:396: received 48 replay messages, want 50 (messages were dropped)
```

The test expects exactly 50 replay messages but occasionally receives 48 or 49 due to a race condition. The test sends 50 messages rapidly and then immediately attaches a replay viewer, but message ingestion and replay buffer population are not fully synchronized.

This has been observed multiple times across different PRs and is pre-existing on main. It blocks CI when it flakes, requiring manual reruns.

## Root Cause Analysis

The race condition is between:
1. Messages being broadcast to the SessionHost via `BroadcastEvent`
2. The replay buffer being read by a newly attached viewer via `AttachViewer`

The replay buffer uses a mutex-protected slice, but the test doesn't wait for all 50 messages to be fully ingested before attaching the replay viewer. Under CI load (shared runners, CPU contention), message delivery can be slightly delayed.

## Proposed Fix Options

### Option A: Synchronize test with message count (Preferred)

Add a helper that waits until the SessionHost's internal message count reaches the expected value before attaching the replay viewer:

```go
// Wait for all messages to be ingested
waitForMessageCount(t, host, 50, 5*time.Second)

// Now attach replay viewer
viewer := host.AttachViewer("replay-v1")
```

### Option B: Use eventually/retry assertion

Replace the exact count assertion with a retry loop:

```go
assert.Eventually(t, func() bool {
    msgs := viewer.DrainReplayMessages()
    return len(msgs) >= 50
}, 5*time.Second, 10*time.Millisecond)
```

### Option C: Add small sleep before replay (least preferred)

A `time.Sleep(50*time.Millisecond)` before attaching the replay viewer. Simple but brittle.

## Related Files

| File | Role |
|------|------|
| `packages/vm-agent/internal/acp/session_host_test.go` | Flaky test (line ~396) |
| `packages/vm-agent/internal/acp/session_host.go` | SessionHost replay buffer implementation |

## Acceptance Criteria

- [x] `TestSessionHost_ReplayDoesNotDropMessages` passes reliably (100/100 runs with `-count=100`)
- [x] No `time.Sleep` used as the fix (Options A or B preferred)
- [x] Other replay-related tests still pass
- [x] Run with `-race` flag to verify no data races
