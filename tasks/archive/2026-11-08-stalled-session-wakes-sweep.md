# Stalled session wakes: end dead wake claims and surface long wakes

SAM task `01M6WSR7YR942ASC4AMK9BT6XK`. Primary idea `01M6M7AN6G8WTHRYACB9ZS0BGV`; related idea
`01M6MCNSKJG34QS64NAJK1TXRE` (fixed separately by #2534, see below).

## Problem

A user's sleeping chat never comes back. The chat shows a "waking" banner that never
clears, and on some chats every new message is refused with "SAM spent the wake retry
budget for this sleep snapshot." In production, `session_snapshots` rows stay at
`recovery_status='waking'` for days to weeks.

## Evidence (production D1, read-only, 2026-11-08 05:30Z)

9 rows are `waking`. One is a live wake (`01M6WKKMRA44ZBTG6EQJGQ53CD`, claimed 05:24Z, task
`queued` at `node_agent_ready`). The other 8 fall into two classes:

**Class A: the TaskRunner failure path stopped partway (5 rows, 2026-10-11..19).**
Snapshots `01M4NB1QR8CG4V799WEENYXYEY`, `01M4S991D67519QWQGVM675DMQ`,
`01M4QMK5FW8C32W3GG20MDK7DQ`, `01M51TRMP6YCQ5G8K9JDR9QRC5`, `01M52PJA9W44QHR795RXAR9B93`.
Every recovery task has a `task_status_events` row "Wake attempt failed; saved conversation
retained: …" (`returnFailedWakeToSleep`, written by `failTask` in
`durable-objects/task-runner/state-machine.ts`) and is `sleeping`, yet the snapshot still
has the claim's `recovery_claimed_at`, no `recovery_failed_at`, and status `waking`. So
`failRecoveryLifecycle` (`recovery-failure-cleanup.ts`) never reached its last step,
`failSessionSnapshotRecovery`. Its earlier steps (re-sleep the ProjectData session, release
the workspace binding, `cleanupOnFailure`) can throw or return early through
`ownsRecoveryAttempt`. The TaskRunner retries a throw only through Cloudflare's bounded
alarm retries (`alarm()` → `failTask` while `wakeFailureMessage` is set), and nothing
outside the DO ever finishes the job. Failure texts were `UNIQUE constraint failed:
workspaces.chat_session_id` and `SESSION_LINK_STATUS_REFUSED`. Worker logs from October
are past retention and no `platform_errors` row was written, so the exact throw per row
cannot be recovered. #2377's `reconcileSessionRecoveryBindingFailure` already repairs one
narrow sub-case (the UNIQUE collision), and only lazily on the next wake attempt.

Two rows had spent the wake budget (`recovery_attempts=3`). With `recovery_failed_at` NULL
the budget never decays (`session-snapshot-recovery-budget.ts`), so every later message was
refused with "SAM spent the wake retry budget". That is the "never comes back" symptom.

**Class B: the wake task was cancelled mid-wake (3 rows, 2026-11-01..02).**
Snapshots `01M6CJMG56KA6J35Y11G1TSDP3`, `01M6CGBE7DS11ERJF9Q4PE8W47`,
`01M6E3TQP6KYESZKXNGCVAKFD0`. The parent agent removed the reactivated task ("Removed by
parent task 01M6CFWZNE9H67CHT3CNWB4FJT") while it was queued behind a provider-limit wait.
No path ends the snapshot claim when another actor terminalizes the wake's task.

**Not stuck any more (class C):** snapshots `01M6GNN22KNPDQRVJ2NHDJ5J8T`,
`01M6GNC38EHNW0PWPSAEQ9ZE9V` and `01M6EANKKF82CYHTD0KHRA8PZC` (the three
`session_snapshot_failure` anomaly rows) were `waking` from 2026-11-02/03 until
2026-11-07 04:55Z, held by a provider-limit wait. #2561 (merged 04:23Z) moved them to
`provider_limit_blocked` with a visible attention marker and `recovery_status='failed'`
through `presentBlockedProviderLimitWait`. Their recovery error is "Blocked: selected
provider credential changed; review before resuming". That is an owner decision, not a
stuck wake.

**Latency warnings:** the ~21 "Lifecycle latency budget exceeded: session_recovery waking"
warnings at 2026-11-04 07:40-07:50Z are the watchdog's first pass after it deployed
(`firstSeenAt` 07:20:25 for every row). Their `ageMinutes` counts from the watchdog's first
sighting, not from the wake. They are the stuck rows above, not 15-30 minute wakes. Later
single warnings (11-05..07) are individual slow wakes that finished.

**What the user sees:** `routes/chat/wake-state.ts` hydrates `recoveryStatus='waking'`, and
`useSessionLifecycle.ts` turns that into `agentActivity='recovering'` (the wake banner),
forever. `tasks_read agents` lists the class A tasks as `awake-idle`.

**Deletion fence:** this is not the cause. All 8 sources carry
`runtime_deletion_proof='node_runtime_terminated'`, which
`replacement-deletion-fence.ts` accepts.

**Idea 01M6MCNSKJG34QS64NAJK1TXRE** (the metadata race) was fixed by #2534
(`7f269116c fix(vm-agent): prevent stale deletion records from blocking wake`). It is not
part of this task.

## Root cause

The TaskRunner that owns a wake is the only writer that ever ends a VM wake claim
(`failSessionSnapshotRecovery`, `markSessionSnapshotRestored`). The lazy stale-claim path
in `claimSessionSnapshotRecovery` re-claims only when a new wake attempt arrives, and the
scheduled sweeps never select `waking` rows. When the owner stops partway (class A) or
someone else terminalizes its task (class B), the claim outlives its attempt. The chat
stays `waking` and its retry budget never decays.

## Design

1. **Shared liveness predicate (rule 58).** Extract the resumer's "this wake task is still
   live" status set (`queued, delegated, in_progress, awaiting_followup`, used today by the
   lazy renewal in `claimSessionSnapshotRecovery`) and the claim lease
   (`SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS`). The sweep and the resumer both use them.
2. **Bounded sweep** `scheduled/session-wake-claim-reconciliation.ts`, isolated in the cron
   handler. It selects VM `waking` rows whose claim is older than the lease and whose
   recovery task is missing, or not live and unchanged for a full lease. That is stricter
   than the resumer: the sweep never releases a claim while the owning runner may still be
   inside `failRecoveryLifecycle`. One D1 batch then ends each row with a compare-and-set on
   `recovery_task_id`, `recovery_attempt_id`, the stale claim and the task predicate
   (status `failed`, `recovery_failed_at` = when the attempt ended, `recovery_claimed_at`
   cleared). A live wake, or a claim renewed or re-claimed since selection, no-ops. Open
   clients get a best-effort `notifyWakeSettled(failed)` push.
3. **Visible recoverable state.** `recovery_status='failed'` turns the banner off.
   `recovery_failed_at` starts the attempt-budget decay, so the next message can wake the
   chat. The snapshot and WIP are untouched.
4. **Ops anomaly class** `session_wake_stalled`: `waking` rows whose claim is older than
   `operations.opsAnomalyWakingMinutes` (default 60), with the recovery task's status.
5. **Remediation:** after deploy the sweep ends the 8 dead rows itself. That is a
   production data change, so Raphaël approves it before merge.

## I/O budget per sweep tick (rule 47/60)

1 settings read (cached), 1 bounded SELECT, at most 1 D1 batch (N CAS updates in one round
trip), and N best-effort DO pushes in `waitUntil` (`N ≤ operations.deadWakeReconcileBatchSize`,
default 10). Worst case is 3 + N = 13 round trips, under the 30-per-tick budget. Each
selected candidate leaves the set on success, and a CAS loser no longer matches the
selector. Throughput: 10 per 5-minute tick, so a backlog of 100 clears in under an hour.
The expected steady-state volume is 0-2.

## Implementation checklist

- [x] Extract `LIVE_WAKE_TASK_STATUSES` and an exported claim-lease resolver; the resumer uses them
- [x] Sweep service with selection, batch CAS release and push; log every release
- [x] Wire the sweep into `scheduled/handler.ts` with isolation and a completion-log field
- [x] Admin settings `operations.deadWakeReconcileBatchSize` and `operations.opsAnomalyWakingMinutes`
- [x] Split `fleet-ops/anomalies.ts` (494 lines) before adding the class; add `session_wake_stalled`
- [x] Update the MCP tool description, playbook and docs (agents.md, admin-settings.md, api.md as needed)
- [x] Tests (real SQLite engine, through the real sweep and the real `claimSessionSnapshotRecovery`):
  - [x] class A row released; the next user wake claims it again (budget decayed)
  - [x] class B row (cancelled task) released
  - [x] missing task released
  - [x] live-wake control: queued/in-progress task with a stale claim is untouched
  - [x] fresh-claim control: a sleeping task inside the lease is untouched
  - [x] recently-ended task control: task updated inside the lease is untouched
  - [x] CAS: a claim renewed or re-claimed between select and update is untouched
  - [x] cf-container rows untouched; batch cap honoured; a second sweep is a no-op
  - [x] anomaly class reports an old waking row and skips a fresh one
  - [x] discrimination: delete the live-task predicate and the live control goes red
- [x] Staging: a real sleep/wake cycle completes; force a dead claim and watch the sweep end it (sweep ended 4 real dead claims; forced claim recovered by the lazy path first, see notes)
- [ ] Remediation evidence plus Raphaël's approval before merge

## Acceptance criteria

- [x] Root cause recorded with evidence (above), and the idea updated
- [x] Bounded sweep ends dead claims with a CAS on `recovery_attempt_id` and never touches a live wake
- [x] The chat ends `failed` (visible, banner off) with a decaying budget, not stuck `waking`
- [x] Ops anomaly class for wakes older than a configurable threshold
- [ ] Existing stuck rows remediated with evidence after approval
- [x] Tests through the real entry points, including a live control and a discrimination check
- [x] Thresholds configurable; I/O budget stated
- [x] Staging verified with a real sleep/wake cycle

## Implementation notes

- Review fix: the resumer's lost-race fallback (`claimSessionSnapshotRecovery`) reported `waking` for
  whatever task the row named, even after the sweep had ended that claim. It now re-claims once.
  Both race directions are tested with the real resumer.
- Legacy claims with `project_id` NULL exist on staging; the push is skipped for them.
- Expired snapshots are purged by `session_snapshot_purge` in the same tick, once their claim ends.
  That purge skips `waking`, so stuck claims had also been blocking retention. Raphaël was asked to
  approve this as part of the production remediation.
- Staging (deploy 42453495012): the deployed sweep ended all 4 pre-existing dead staging claims on
  its first tick. A fresh class B (task cancelled mid-wake) was reproduced on chat 4d9b2389: the UI
  showed "Waking and restoring session..." while the task was cancelled.

## Staging evidence (2026-11-08)

- Deploys 42452045297 and 42453495012 (final head d8b5f47fb) succeeded.
- 06:05Z tick: the deployed sweep ended all 4 pre-existing dead staging claims (tasks failed x2,
  cancelled with budget spent x1, missing task with NULL project x1). `recovery_failed_at` was set to
  each task's end time. The two expired snapshots were then purged by `session_snapshot_purge`.
- Real sleep/wake cycle, chat 9a2124fe: slept 06:33, prompted, wake claimed 06:33:24, restored
  06:40, and the agent replied "pong" after the wake (screenshot). The sweep ticks at 06:35 and 06:40
  left the live wake alone.
- Forced dead claim, chat 4d9b2389: task cancelled 06:35:41 mid-wake. The UI showed "Waking and
  restoring session..." on a chat whose task was cancelled (the exact symptom). Because a durable
  prompt was still pending, the lazy resumer re-claimed at 06:46:30, before the sweep was due, and the
  wake restored at 06:47. The production rows had no pending prompt, which is why they stayed stuck.
- No `platform_errors` rows for the sweep since deploy. Both chats were slept and their workspaces
  deleted afterwards.
