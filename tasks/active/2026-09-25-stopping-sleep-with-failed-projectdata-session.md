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

- [x] A `stopping` row whose ProjectData session is `failed` (non-failed task) leaves the sweep's
      candidate set within a bounded number of sweeps (rule 47), with a recorded terminal reason.
- [x] The runtime is torn down and the snapshot is not presented as wakeable.
- [x] A two-sweep regression test against real SQL, plus a control that a `sleeping`/`stopped`
      ProjectData session still completes as sleeping.

## 2026-10-08 implementation scope

SAM task 01M4DV45S0WXQETVAEPVJY5M2K; idea 01M3MFDMZ5AS0BXPHZWS3CRFED.
Existing backlog reused in SAM's pre-created isolated output branch.

Research: failTask terminalizes stable owner before failRecoveryLifecycle; cleanup finalizer
skips snapshot checks for failed/error and scopes the check to the old workspace, although
wake uses a replacement. ProjectData link rejects failed sessions and unknown errors retry.
Sleep repair deliberately excludes failed sessions of non-failed tasks; stopping candidate
selection has no age bound. Recovery budgets decay after clean failures; cooldown is not
permanent loss of recoverability.

- [x] Return a recoverable stable wake task to sleeping before terminal hooks; fence attempt ownership.
- [x] Preserve authoritative restorable snapshots through replacement cleanup; genuine loss remains visible.
- [x] Heal failed ProjectData sessions only under an authorized snapshot wake claim.
- [x] Classify status refusal as permanent across RPC error serialization.
- [x] Bound stopping selection on immutable stopping age; repair failed non-failed-task sessions to terminal failure with reason and cleanup.
- [x] Real alarm → failure → finalizer SQL regression, parent-hook assertion, unrecoverable control, next-wake and status-refusal coverage.
- [x] Two-sweep real SQL regression for stopping repair.
- [x] Local checks and specialist reviews.
- [ ] Coordinated staging lease and live verification.
- [ ] PR/CI/CodeRabbit/merge/production; idea evidence and channel cleanup.

No migration planned. Shared channel reliability-wave-1008; expiry owns expired end state,
8h task owns failure-preservation preparing/stopping reaper predicate. Rules 47, 58, 62, 66.

## Implementation and regression evidence

Recoverable stable wakes now retain a sleeping task without terminal parent notifications.
The failure marker is durable before the task transition, so interrupted cleanup resumes
without replaying restoration. ProjectData is returned to sleep under the observed identity;
the wake claim remains held through runtime cleanup and is released only afterward.
Failed mirrors heal only under the same snapshot/task/attempt authority, using failed-only SQL.
Snapshot preservation includes replacement workspace ownership and failed-wake cooldown, bounded
by snapshot expiry. Genuinely unavailable snapshots still terminalize visibly.

Stopping selection now stops retrying after the existing in-flight ceiling. Lifecycle repair
records terminal_failed with a reason for failed sessions whose task is not failed, closes
compute, and removes them from subsequent candidates. Existing sleeping/stopped controls remain.

Local verification: 110 focused alarm/handoff/finalizer/predicate/repair checks and 86 surrounding
idle-cleanup/sleep/agent-session tests pass. Six isolated mutation checks fail for the intended
assertion when task preservation, finalizer preservation, failed-mirror healing, cleanup replay,
stopping age, or failed-session repair is removed. The status-link-refusal regression enters
through TaskRunner.alarm -> workspace_creation -> actual ProjectData link SQL and asserts
first-alarm settlement without restoration or terminal parent hooks.
Full API rerun PASS: 827 files / 11,630 tests; all other root test tasks passed. Root lint,
typecheck and build passed, with affected API rechecks. File-size, source-contract, runtime-state
and runtime-boundary checks passed. Coordinated staging/PR/deployment evidence is pending below.

## Incident lesson

The failure was not a failed snapshot: a temporary replacement-runtime failure was incorrectly
treated as the conversation's terminal outcome, then a second finalizer overwrote the earlier
sleep transition. Helper-only tests missed this composition and the false parent notification.
The durable process guard is rule 62's production-entry regression requirement, applied here to
the real alarm/failure/finalizer path, plus rule 47's two-sweep convergence assertion. No extra
standing rule is needed; the regression and guard-removal proofs enforce the existing guidance.

Candidate/I/O budget: production wakes are about 5-10/day. Recoverable failure adds bounded
identity/CAS work to one attempt and avoids terminal fanout and repeated deadline polling.
Stopping candidates shrink after the existing age ceiling; repair keeps its existing default
25-row batch and per-row snapshot verification/ProjectData/cleanup calls. No migration or new
timer, unbounded query, external API, or environment variable was added.
