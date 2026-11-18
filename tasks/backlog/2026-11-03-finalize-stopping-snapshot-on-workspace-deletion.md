# Finalize a `stopping` sleep snapshot as sleeping when its workspace is deleted

## Problem

Deferred MEDIUM finding (M4) from the adversarial review of `sam/required-sleep-must-not-fail`.

A sleep that has crossed its point of no return (`sleep_status = 'stopping'`) already holds a
verified final snapshot. If the workspace is deleted before the sweep rolls that teardown forward
(the node is deleted by hand, or the lifetime sweep reaps it), the sweep's dead-intent path retires
the intent (`retireDeadWorkspaceSleepIntent`). With the fix on that branch the chat is then closed
(`closeChatOfDeletedSleepWorkspace`). That converges, but it throws away a verified recovery point:
the chat could have been left asleep and wakeable instead.

## Context

- `apps/api/src/scheduled/session-sleep.ts`, dead-intent branch
- `apps/api/src/services/session-sleep-fallback-state.ts` (`retireDeadWorkspaceSleepIntent`)
- `apps/api/src/services/session-sleep-deleted-workspace.ts`
- `apps/api/src/services/workspace-lifecycle-finalizer.ts` (`findRestorableOrInFlightSleepSnapshot`)

## Acceptance Criteria

- [ ] A `stopping` snapshot whose artifacts re-verify is marked sleeping (sets `sleeping_at`) when
      its workspace is deleted, and the ProjectData session sleeps instead of closing
- [ ] A `stopping` snapshot whose artifacts no longer verify still converges to a closed chat
- [ ] Real-SQL tests for both, entered through the sweep
