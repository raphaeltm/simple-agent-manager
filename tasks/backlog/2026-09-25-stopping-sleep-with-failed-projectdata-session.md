# A `stopping` sleep whose ProjectData session is already `failed` retries forever

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
