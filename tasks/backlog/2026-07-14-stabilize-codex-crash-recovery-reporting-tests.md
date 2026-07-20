# Stabilize Codex Crash-Recovery Reporting Tests

## Problem

Two VM-agent ACP crash-recovery tests intermittently fail after a successful Codex session load because the recovery callback is not observed within the test's timing window. The failures reproduce unchanged on `main`, so they are unrelated to the Codex tool-output persistence implementation, but they make broad `go test ./internal/acp/...` results noisy.

## Evidence

- `TestSessionHost_CodexCrashRecovery_ReportsRecovered` fails after logs show `LoadSession` succeeded.
- `TestSessionHost_CodexCrashRecovery_LoadsCapturedSessionAfterLivePrerequisitesClear` fails under the same condition.
- Both failures reproduce in the clean primary checkout on `main` and on the feature worktree.
- Focused tool-output extraction tests pass; the failing tests do not exercise raw-output normalization or message persistence.

## Implementation Checklist

- [ ] Reproduce the callback timing failure repeatedly with the ACP package test suite.
- [ ] Identify whether the race is in production recovery sequencing, test synchronization, or callback observation.
- [ ] Replace wall-clock-sensitive assertions with deterministic synchronization where appropriate.
- [ ] Preserve the production recovery contract: a successfully reloaded Codex session reports recovered exactly once after prerequisites clear.
- [ ] Add or refine scenario tests for delayed callback delivery and session-load completion ordering.
- [ ] Run the full VM-agent ACP package suite repeatedly and under the race detector.

## Acceptance Criteria

- Both crash-recovery reporting tests pass deterministically across repeated runs.
- Tests still fail when the recovered callback is omitted or emitted before required recovery state is established.
- No production retry/recovery behavior is weakened merely to satisfy test timing.
- `go test ./internal/acp/...` and the relevant race-enabled suite pass.
