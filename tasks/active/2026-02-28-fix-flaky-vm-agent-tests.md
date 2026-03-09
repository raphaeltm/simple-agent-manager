# Fix Flaky VM Agent Tests

**Created**: 2026-02-28
**Status**: Active
**Priority**: Medium
**Estimated Effort**: Medium

## Problem

`TestSessionHost_ReplayDoesNotDropMessages` in `packages/vm-agent/internal/acp/session_host_test.go` is a known flaky test. It intermittently fails in CI with messages like:

```
session_host_test.go:396: received 48 replay messages, want 50 (messages were dropped)
```

The test expects exactly 50 replay messages but occasionally receives 48 or 49 due to a race condition. The test sends 50 messages rapidly and then immediately attaches a replay viewer, but message ingestion and replay buffer population are not fully synchronized.

This has been observed multiple times across different PRs and is pre-existing on main. It blocks CI when it flakes, requiring manual reruns.

## Root Cause Analysis

The actual root cause is in `AttachViewer` (`session_host.go`), not in test synchronization. After `replayToViewer()` sends all 50 messages to the viewer's send channel via blocking `sendToViewerWithTimeout`, the post-replay control messages (`replay_complete` and post-replay `session_state`) were sent via `sendToViewerPriority`. When the viewer's send channel is full (write pump hasn't drained all replay messages yet), `sendToViewerPriority` **evicts a queued replay message** to make room for the priority message. This drops 1-2 replay data messages, explaining the "received 48 replay messages, want 50" failure (50 - 2 evictions = 48).

### Original (incorrect) analysis

The race condition was thought to be between:
1. Messages being broadcast to the SessionHost via `BroadcastEvent`
2. The replay buffer being read by a newly attached viewer via `AttachViewer`

However, in the test, all 50 `broadcastMessage` calls complete synchronously before `AttachViewer` is called, so the buffer is always fully populated. The real issue was message eviction in the send channel.

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

## Fix Applied

Changed `AttachViewer` in `session_host.go` to use `sendToViewerWithTimeout` (blocking) instead of `sendToViewerPriority` (evicting) for the post-replay control messages (`replay_complete` and post-replay `session_state`). This ensures all replay data messages are delivered before control messages are sent.

## Acceptance Criteria

- [x] `TestSessionHost_ReplayDoesNotDropMessages` passes reliably (10/10 runs with `-count=10 -race`)
- [x] No `time.Sleep` used as the fix
- [x] Other replay-related tests still pass
- [x] Run with `-race` flag to verify no data races
