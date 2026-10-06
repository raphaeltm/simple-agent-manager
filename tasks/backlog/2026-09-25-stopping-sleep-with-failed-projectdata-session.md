# A `stopping` sleep whose ProjectData session is already `failed` retries forever

> **Reconciliation 2026-10-05:** Still open; pointer correction. The failed-session predicate
> is now `apps/api/src/scheduled/session-sleep-lifecycle-repair.ts:51-55` (the `failed` arm at
> `:54`), and the retry when the session is not already closed is at `:167`. The recovery-workspace
> finalize with `agentSessionStatus: 'failed'` moved to
> `apps/api/src/durable-objects/task-runner/state-machine.ts:641-648`. #2223's bounded sleep
> episode does not cover a sleep stuck in `stopping`. Since #2230 a failed VM wake also fails the
> conversation's own task (`state-machine.ts:305`); see SAM idea `01M3MFDMZ5AS0BXPHZWS3CRFED` and
> `2026-10-05-sleeping-task-status-follow-ups.md`.

> **Reconciliation 2026-09-30:** still open (`session-sleep-lifecycle-repair.ts:48,171` unchanged).
> Same class as SAM idea `01M3MFDMZ5AS0BXPHZWS3CRFED`, also unfixed:
> `apps/api/src/durable-objects/task-runner/state-machine.ts:582-589` finalizes recovery workspaces
> with `agentSessionStatus: 'failed'`, which fails a conversation its snapshot says is recoverable.
> Fix the two together.

## Problem

A sleep that has passed its point of no return (`session_snapshots.sleep_status = 'stopping'`)
is finished by `runSessionSleepLifecycleRepair()`
(`apps/api/src/scheduled/session-sleep-lifecycle-repair.ts`) only when the ProjectData session
is already `sleeping` or `stopped` — or, since the failed-task preservation work, `failed` for a
FAILED task. For any other task (for example a completed one) whose ProjectData session was
failed by a terminal reconciler or an `error` activity fanout while its sleep sat at `stopping`,
neither the repair nor the sweep can finish it: `stopping` has no attempt budget, so the sweep
re-selects the row every five minutes indefinitely.

This is pre-existing on `main`. Accepting `failed` for every task was tried and rejected in the
failed-task preservation review (round 2, M1): it marks a snapshot `sleeping` whose ProjectData
session can never wake, and the stuck-task guard then keeps that unwakeable conversation for the
snapshot's whole retention.

## Context

Found by the round 3 review of `sam/preserve-failed-tasks-work-fn8ba7` (idea
`01M1XGHX7NQZQYWQRV5C1PJ60N`, task `tasks/archive/2026-09-25-preserve-failed-task-work.md`).

## Acceptance Criteria

- [ ] A `stopping` row whose ProjectData session is `failed` (non-failed task) leaves the sweep's
      candidate set within a bounded number of sweeps (rule 47), with a recorded terminal reason.
- [ ] The runtime is torn down and the snapshot is not presented as wakeable.
- [ ] A two-sweep regression test against real SQL, plus a control that a `sleeping`/`stopped`
      ProjectData session still completes as sleeping.
