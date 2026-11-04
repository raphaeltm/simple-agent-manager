# Follow-up sent during a conversation's first provisioning raises "wake_failed"

## Problem

A durable follow-up sent to a new VM conversation before its workspace row exists is attempted
immediately. `resolveVmPromptDeliveryTarget()` (`apps/api/src/services/vm-prompt-delivery-target.ts`)
finds no workspace row, takes the `!row` branch and calls `ensureSessionRecovery()`. The task is
still queued for its first placement, not sleeping, so recovery refuses. The delivery fails as
`wake_refused` and the chat gets a `wake_failed` attention marker (`raiseSessionWakeFailure`), even
though the conversation is simply still starting.

## Context

Found on staging 2026-11-04 during verification of `sam/fix-stale-prompting-sleep-81sme3`.
Session `6e19ba34-b6d3-450d-9832-441b1294eaa8` (project `01KWHD8XS7MQ7R6KWXJYRHDVH4`): the
conversation was submitted at 15:23:17Z, a follow-up was posted at 15:23:53Z while the VM was
provisioning, and the session showed `attention.kind = 'wake_failed'`, `reason = 'wake_refused'`.
Not caused by that branch (its hold runs after the `!row` branch).

## Acceptance Criteria

- [ ] A follow-up to a conversation whose first placement is still in progress (task queued or
      delegated, no workspace row yet) is retried as `not_ready`, not failed as `wake_refused`.
- [ ] No `wake_failed` attention marker for that case; a genuinely refused wake still raises one.
- [ ] The retried follow-up is delivered once the agent session is running (real delivery runner
      test, controlled ordering per rule 62).
