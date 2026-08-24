# cf-container: markRuntimeSleeping never re-checks harness lease

## Problem

The cf-container `onActivityExpired` path checks the harness work lease exactly once at the top of the method, before calling `markRuntimeSleeping()`. The `markRuntimeSleeping()` method then performs R2 snapshot-artifact verification (`verifySessionSnapshotArtifactsForSleep`) and `beginSessionSnapshotStopping` — real elapsed time — with **no re-check** of harness state.

The VM-neutral path (`sleepWorkspaceSession` in `session-sleep.ts`) checks at **three** gates (`stateBefore`, `stateAfter`, `stateAtStop`) specifically to close this window. The cf-container path should do the same.

## Context

- Discovered by cloudflare-specialist review during PR #1845 cf-container harness lease integration
- The race window is narrower than the original bug (minutes of sleep-sweep delay vs. seconds of R2 verification), but conceptually identical: harness work can start during the verification window and be killed by the subsequent sleep
- The VM-neutral cron sweep (`sleepWorkspaceSession`) also handles `nodeRuntime === 'cf-container'`, which provides an independent safety net for most cases — but the container's own `onActivityExpired` path fires first in practice

## Acceptance Criteria

- [ ] `markRuntimeSleeping()` (or its caller in the cf-container path) re-checks harness lease state after snapshot artifact verification and before `beginSessionSnapshotStopping`
- [ ] At minimum, add a `stateAfter` re-check between the R2 round-trip and the final stop command
- [ ] Regression test: harness work starts during the verification window → sleep is aborted
- [ ] Test is proven discriminating (fails without the re-check)
