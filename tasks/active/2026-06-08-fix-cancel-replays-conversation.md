# Fix project-chat cancel replaying the conversation

## Problem

Clicking the cancel button on the "agent is working" bar in project chat causes the
entire conversation to visibly replay in the chat UI. Cancel should simply stop the
current turn (a follow-up message can still be sent afterwards) with **no replay**.

Raphaël taps cancel repeatedly because the cancel button appears only briefly — so the
fix must be robust to multiple cancels.

## Root Cause (verified)

Cancel kills and restarts the agent process (commit `079ec081`, ~2026-06-01) because
some agents lack native `session/cancel` support.

1. `StopProcessForPromptCancel` sets `intentionalPromptCancelProcessStop = true`
   (`session_host.go`).
2. `monitorProcessExit` restarts the agent with `loadSessionID` set
   (`session_host_process.go:93-97`):
   ```go
   loadSessionID := ""
   if intentionalPromptCancel || crashRecovery.inProgress {
       loadSessionID = previousAcpSessionID
   }
   ```
3. The restart triggers ACP `LoadSession` in `tryLoadPreviousACPSession`
   (`session_host_handshake.go:114`).
4. LoadSession makes the agent replay the **entire transcript** as `session/update`
   notifications.
5. `sessionHostClient.SessionUpdate` (`session_host_client.go:40`) **unconditionally**:
   - broadcasts each update to every viewer (live replay in the browser), AND
   - re-persists via `MessageReporter.Enqueue` after `ExtractMessages`
     (`message_extract.go` assigns **fresh UUIDs** — so frontend dedup in
     `apps/web/src/lib/merge-messages.ts` cannot suppress them).

The result: the browser sees the whole conversation stream in again, and the control
plane stores duplicate messages.

## Fix (Option A — pre-approved)

Add a lock-free `replaySuppressed atomic.Bool` to `SessionHost`. Set it true around the
LoadSession call inside `tryLoadPreviousACPSession` (with a `defer` to always clear it),
and early-return in `SessionUpdate` (after `defer c.signalProcessed()`) when the flag is
set. This single choke point covers all three sinks:
- live viewer fan-out (`broadcastMessage`),
- late-join replay buffer (`broadcastMessage` → `appendMessage`),
- control-plane persistence (`MessageReporter.Enqueue`).

The `defer` is scoped to the END of `tryLoadPreviousACPSession` (covering the
`applySessionSettings` RPC round-trips that follow LoadSession) to widen the suppression
window and avoid a tail-race where the orderedPipe delivers the LoadSession *response*
(ID != nil, not serialized) before the final replayed `session/update` handler runs.

Out of scope: the "auto-cancel then submit follow-up as one action" UX idea — do NOT
touch submit behavior.

## Implementation Checklist

- [ ] Add `import "sync/atomic"` and `replaySuppressed atomic.Bool` field to
      `SessionHost` (`session_host.go`).
- [ ] In `tryLoadPreviousACPSession` (`session_host_handshake.go`), after the
      early-return guards and before the LoadSession context is built, set
      `h.replaySuppressed.Store(true)` with `defer h.replaySuppressed.Store(false)`.
- [ ] In `SessionUpdate` (`session_host_client.go`), early-return after
      `defer c.signalProcessed()` when `c.host.replaySuppressed.Load()` is true.
- [ ] Test 1: unit test of the `SessionUpdate` gate — suppressed vs not-suppressed,
      asserting viewer/buffer delivery AND `MessageReporter.Enqueue`.
- [ ] Test 2: capability/regression test driving `tryLoadPreviousACPSession` against an
      in-process fake ACP agent that emits `session/update` during LoadSession — assert
      replay is suppressed, flag cleared after, and a post-load update still broadcasts.
- [ ] `go build`, `go vet`, `go test ./internal/acp/...` green.

## Acceptance Criteria

- [ ] Cancelling a prompt mid-turn does NOT replay the conversation in the browser.
- [ ] No duplicate messages are persisted to the control plane during cancel restart.
- [ ] After cancel, a follow-up message still gets a full-context response.
- [ ] The suppression flag is always cleared after LoadSession (no permanently muted
      session).
- [ ] Staging (rule 27): all nodes deleted, redeploy, NEW project chat — reproduce
      cancel mid-turn → no replay → follow-up works, zero errors.
