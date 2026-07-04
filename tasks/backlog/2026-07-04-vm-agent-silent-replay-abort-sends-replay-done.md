# Fix: silent replay abort still delivers `replay_done` (vm-agent)

## Problem

`replayToViewer` (`packages/vm-agent/internal/acp/session_host_broadcast.go`) replays
buffered messages to a newly attached viewer using per-message
`sendToViewerWithTimeout(viewer, msg.Data, 5*time.Second)`. When a send times out
(the viewer's `sendCh` is full and the write pump is stalled — slow client, network
backpressure, or goroutine starvation), the loop `break`s, silently dropping the
remainder of the replay. `AttachViewer` (`session_host.go`) then still sends
`replay_done` (with a fresh 5s timeout that can succeed once the pump drains).

**Result:** the client receives a complete-looking replay (`session_state` →
partial messages → `replay_done`) with an arbitrary suffix of buffered messages
missing, and has no signal that anything was dropped. This was observed on CI as
`TestSessionHost_ReplayDoesNotDropMessages` receiving 48–49 of 50 messages — the
test flake was a real product behavior, not a test bug.

## Context (where/when discovered)

Discovered 2026-07-04 during root-cause analysis for
`tasks/active/2026-07-04-fix-flaky-tests-at-root.md` (branch
`fix-flaky-tests-at-root`). The flaky test was fixed test-side (viewer send buffer
sized above replay volume + concurrent client reader); this product bug was
explicitly kept out of that PR because a behavioral change to the replay protocol
deserves its own PR with vm-agent staging/infrastructure verification
(`.claude/rules/02-quality-gates.md` infra gate, `.claude/rules/27-vm-agent-staging-refresh.md`).

## Notes on design options

- Option 1: on replay send timeout, close the viewer connection instead of
  breaking + sending `replay_done`. The client reconnects and re-attaches, getting
  a fresh full replay. Simple, correct, matches "fail fast" (rule 11).
- Option 2: include `droppedCount` / `replayCount` in `replay_done` so clients can
  detect an incomplete replay and re-attach.
- Option 3 (complementary): log at Warn+ with sessionID/viewerID/dropped count
  (currently `dropped` is counted; verify it is surfaced at Warn level with full
  diagnostic context).
- Whatever the fix, the pre-replay `session_state.replayCount` already tells the
  client how many messages to expect — Option 2 may be nearly free.

## Regression-test coverage note

The old flaky test used `ViewerSendBuffer: 8` (below the 50-message replay
volume), which exercised the blocking `sendToViewerWithTimeout` backpressure path.
The fixed test uses `ViewerSendBuffer: 64`, so that small-buffer backpressure path
is no longer exercised by `TestSessionHost_ReplayDoesNotDropMessages`. The fix for
this bug MUST restore deterministic coverage of the small-buffer/stalled-pump path
— e.g., a test with a deliberately stalled reader asserting the chosen behavior
(connection close, or `replay_done` carrying a dropped/incomplete marker), without
`time.Sleep` and passing `go test -race -count=100`.

## Acceptance Criteria

- [ ] A viewer whose replay is aborted mid-stream can detect the incomplete replay
      (connection closed, or explicit incomplete/dropped signal in `replay_done`)
- [ ] Replay abort is logged at Warn+ with sessionID, viewerID, dropped count,
      and buffered total (structured logging per rule 11)
- [ ] Behavioral regression test covers the stalled-pump/small-buffer path and the
      chosen abort behavior; passes `go test -race -count=100 ./internal/acp/`
- [ ] Browser client (`packages/acp-client` / web) handles the chosen signal
      gracefully (re-attach or surface an error) — or explicit justification if
      the server-side close already triggers the existing reconnect path
- [ ] Staging verification includes a real VM per the vm-agent infra gate
