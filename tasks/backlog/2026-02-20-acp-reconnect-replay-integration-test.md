# Add ACP Reconnect Replay Integration Test

**Created**: 2026-02-20
**Priority**: Low
**Classification**: `cross-component-change`

## Context

PR #124 fixed the chat history wipe on reconnect bug (post-replay `session_state` double-clear). All three fixes were implemented with unit tests, but the integration test from the original task was not added.

See: `tasks/archive/2026-02-20-fix-chat-history-wipe-on-reconnect.md`

## Task

Add a Go integration test covering the full reconnect replay cycle:

1. Attach a viewer to a SessionHost with buffered messages
2. Verify replay delivers all messages and ends with `session_replay_complete`
3. Disconnect the viewer
4. Reattach a new viewer
5. Verify the second replay delivers the same messages without drops or double-clear

## Affected Files

| File | Change |
|------|--------|
| `packages/vm-agent/internal/acp/session_host_test.go` | New integration test |

## Acceptance Criteria

- [ ] Integration test covers attach → replay → disconnect → reattach → verify
- [ ] Test verifies message count matches across both replay cycles
- [ ] Test verifies post-replay `session_state` has `replayCount: 0` on both cycles
- [ ] All existing tests continue to pass
