# Preserve a failed task's work instead of tearing down its workspace

SAM task `01M3BQV2YGZ814CTJ9G6FN8BA7`. Idea `01M1XGHX7NQZQYWQRV5C1PJ60N`. Policy `a3780107`
("Agent sessions must preserve work across runtime loss").

## Problem

`cleanupTerminalTaskResources` (`apps/api/src/services/task-terminal-cleanup.ts`) sends a
`completed` task to `queueWorkspaceSessionSleep` (snapshot, then sleep, so the conversation stays
wakeable). A `failed` task instead goes straight to `projectDataService.failSession` and then
`cleanupTaskRun`. That destroys the workspace with no snapshot, so uncommitted or unpushed work is
lost, and the ProjectData chat session becomes `failed`, which can no longer be woken.

## Research (verified 2026-09-25)

### Production evidence (read-only, `sam-prod` D1, last 7 days)

- Failures whose runtime held agent work:
  - 9x "Human input request expired after timeout"
  - 3x "Agent prompt failed" (VM-agent callback)
  - 1x "Agent became unresponsive after SAM check-in"

  The remaining failures were either startup failures (Hetzner 403, no capacity, node agent not
  ready, invalid management token, instant clone) or runtimes that were already gone (4 h/8 h
  liveness timeouts after the 7-day sleep expired, dead-runtime reconciliation).
- **8 of the 9 human-input expiries were already asleep** before the task failed. The sleep came
  about a day before the failure, so a snapshot existed and `sleep_status='sleeping'`. The failure
  path then ran `failSession`, which moved ProjectData from `sleeping` to `failed`. The snapshot
  row survives, but snapshot-recovery wake refuses a `failed` session, so those conversations
  became unwakeable.
- The only orphan-workspace sweep intervention in 7 days was failed task
  `01M32TCPHE7D45WRJ9K6TC49JM` ("Prompt timed out after 8h0m0s"). That is exactly this class; its
  snapshot is still `pending` and was never captured.
- 56 of 214 snapshots touched in 7 days are `degraded/transcript-only` ("Workspace snapshot made
  no progress for 120000ms"). The brief's example task `01M38BQPCNHPS4ACF3FWX9FEJ8` lost its files
  at *sleep* time (a transcript-only snapshot, about a day before the failure), not at failure
  time. Capture reliability is tracked by idea `01M04SB5QS0ASYKDSZR8FFSY38` and is out of scope
  here. It is the reason a degraded capture must be surfaced to the user.

### Code facts

- ProjectData transitions (`durable-objects/project-data/sessions.ts`):
  - `sleepSession` moves only `active → sleeping`.
  - `failSession` moves `active|sleeping → failed`.
  - `wakeSession` and `wakeSessionForSnapshotRecovery` wake `sleeping` sessions (and authorized
    `stopped` ones), never `failed` ones.

  So a preserved failure must not call `failSession`. If it did, the later sleep would dead-end
  at "ProjectData refused the durable sleeping transition".
- The sleep machinery special-cases `completed` only, in three predicates:
  - `classifySessionIdleness` (`services/session-idleness.ts`): drains a stale prompt and reclaims
    immediately once idle.
  - `cancelScheduledSessionSleep` (`services/session-snapshot-sleep-cancel.ts`): its "completing"
    SQL keeps the terminal sleep intent across activity re-reports.
  - `isCompletingSessionProtected` (`durable-objects/project-data/completion-drain.ts`): defers
    terminal-session reconciliation.

  With no changes, a failed task in `prompting` would never sleep, and every 60 s re-report would
  erase its intent.
- Node-cleanup sweeps destroy failed tasks' runtimes while exempting `completed` tasks that have a
  chat session:
  - Phase 4 `sweepOrphanedWorkspaces` (`scheduled/node-cleanup/workspace-phases.ts`)
  - Phase 0 `sweepTerminalCfContainers` (`scheduled/node-cleanup/node-phases.ts`)

  `node_cleanup` runs before `session_sleep` in every 5-minute tick (`scheduled/handler.ts`), so
  without an exemption it always wins the race.
- The attention expiry path (`durable-objects/project-data/attention-expiry.ts`) runs
  `transitionTaskToTerminal(stopWorkspace: true)`, which marks the D1 workspace `stopped` without
  a VM stop. The sleep path then refuses the workspace ("Workspace cannot sleep from status
  stopped"). After that it runs the DO-internal `failSession`, plus `cleanupTaskRun` for check-in
  expiries only.
- Cancelling a failed agent's prompt is NOT safe. The VM agent answers a cancel with an
  `awaiting_followup` callback, and `updateTaskExecutionStepFromCallback` writes
  `errorMessage: body.errorMessage || null`, which would clear the failure banner. So no cancel.
  Stale prompts drain on the classifier's terminal-task interval instead.
- `ensureSessionSnapshotForSleep` and `scheduleSessionSnapshotSleep` are D1-only, so it is safe to
  queue a sleep from inside the ProjectData DO.
- Retention is keyed on the snapshot row, not on task status, so failed-task snapshots and
  sleeping cf-containers follow the same 7-day expiry and purge. Relevant code:
  `DEFAULT_SESSION_SNAPSHOT_TTL_DAYS`, and `runSessionSnapshotPurge` in `scheduled/d1-retention.ts`.
- The wake paths keep working. `ensureSessionRecovery` runs with no source guard for user
  follow-ups (the `requiresLiveSource=0` path), so a `failed` source task is wakeable. Fork is
  transcript-based and has no status gate.
- There is a UI proxy mismatch, and it is harmless. `useSessionLifecycle.wakeAttemptFailed` keys on
  "task failed/cancelled", not on `recoveryStatus==='failed'`. `hydrateState` re-latches on
  `recoveryStatus==='waking'`, so the worst case is a sub-poll flicker. This is filed as a
  follow-up idea, with no `apps/web` change.

### Every path into terminal cleanup (rules 44, 61, 67)

**Preserve.** A live, snapshot-able runtime can hold unpublished work:

| Path | Entry point | Runtime |
|---|---|---|
| VM-agent failure callback (`Agent prompt failed`, fatal ACP errors, prompt timeout) | `routes/tasks/callback.ts` → `cleanupTerminalTaskResourcesOrThrow` | VM + cf-container (the standalone agent posts the same callback) |
| User/API status → `failed` | `routes/tasks/crud.ts POST /:taskId/status` → `cleanupTerminalTaskResourcesOrThrow` | both |
| Human-input expiry | `attention-expiry.ts failExpiredTaskMarker (needs_input)` | both |
| SAM check-in expiry | `attention-expiry.ts failExpiredTaskMarker (reconciliation_checkin)` | both |

**Keep the existing sleep.** The conversation is already asleep or its sleep is in flight: any
failure path above, when `loadTaskSleepPreservation` reports `preserve`. This is the same
predicate the resumer reads (rule 58).

**Destructive by design (control).** These paths express explicit intent:

| Path | Entry point |
|---|---|
| Archive/Stop session | `routes/chat-stop.ts` (`destructiveSessionEnd: true`, even when the task already `failed`) |
| Delete task | `routes/tasks/crud.ts DELETE` (`cancelled` + `destructiveSessionEnd`) |
| Parent stop | `routes/mcp/orchestration-comms.ts`, `sam-session/tools/stop-subtask.ts` (`cancelled`, policy `486d1dd1`) |

**Unchanged, with nothing to preserve:**

- Startup failures, where no agent has run yet:
  - TaskRunner DO `failTask`/`cleanupOnFailure` (it hands off at `running`)
  - `services/instant-session.ts` launch failure
  - `services/submit-instant-task.ts` acceptance failure
- Runtime already gone: `reconciliation-dead-target.ts` (dead target); `stuck-tasks.ts` liveness
  timeouts and dead-runtime reconciliation (sleeping sessions are already withheld by
  `withholdTerminalVerdictForSleepingSession`).
- Malfunction kill switches that burn tokens now: the `stuck-tasks.ts` compaction-loop and
  runaway-cost ceiling branches. Their intent is an immediate stop, and preserving work would first
  require a safe prompt cancel (see the cancel hazard above). Follow-up idea.

## Design

1. New `services/failed-task-preservation.ts` holds a single decision, `preserveFailedTaskWork`.
   It returns one of:
   - `sleep_queued`: the workspace is `running|recovery` on a `vm`/`cf-container` node, with a
     chat session and a resumable agent session. The action is `queueWorkspaceSessionSleep`
     (reason `Task failed`, `sleepAfterMs: 0`).
   - `already_asleep`: `loadTaskSleepPreservation` reports `preserve`.
   - `unknown`: the lookup failed. Destruction is withheld (rule 58, requirement 4).
   - `not_preservable`, with a reason code. The caller falls back to the existing destructive path
     and surfaces a degraded state.

   In the first three outcomes the ProjectData session is never failed.
2. `cleanupTerminalTaskResources`: for `failed && !destructiveSessionEnd`, consult the decision
   first. Only `not_preservable` reaches `failSession` + `cleanupTaskRun`, and it first persists a
   system message stating that the work could not be preserved.
3. Attention expiry: `stopWorkspace: false`, then the same decision. The DO-internal
   `failSession` and `cleanupTaskRun` run only for `not_preservable`, and now for both marker kinds.
   `cleanupTaskRun` owns the real VM stop.
4. Add one named authority for terminal statuses whose conversation is kept by sleep:
   `completed`, `failed`. It is consumed by the three sleep predicates and by both node-cleanup
   phases. All callers are listed in the PR (rule 67).
5. Bounded escape (rule 58, requirement 3; rule 47): when the sleep sweep exhausts a failed task's
   preservation attempts, run the destructive cleanup and persist the degraded message. When a
   failed task sleeps with a snapshot missing workspace files (`transcript-only`/`wip-skipped`/
   `entries-skipped`), persist a message saying so.

## Checklist

- [ ] Add `failed-task-preservation.ts` with the decision, degraded surfacing, and exhaustion/degraded-capture hooks.
- [ ] Add a named sleep-owned terminal-status authority; consume it in `classifySessionIdleness`, `cancelScheduledSessionSleep`, `isCompletingSessionProtected`, and node-cleanup Phase 0 + Phase 4.
- [ ] Route `cleanupTerminalTaskResources` failed (non-destructive) through preservation.
- [ ] Route attention expiry (both kinds) through preservation; `stopWorkspace: false`.
- [ ] Sleep sweep: exhaustion fallback + degraded-capture note for failed tasks.
- [ ] Unit tests: decision outcomes (live VM, live cf-container, already asleep, unknown, each not-preservable reason).
- [ ] Vertical slice (rule 62): failed task with a dirty live workspace, driven from `cleanupTerminalTaskResources` through the real sleep sweep, ends with a verified snapshot, a sleeping workspace, and ProjectData `sleeping` (never `failed`). A real SQL engine drives the D1 state.
- [ ] Route-level test: VM callback `toStatus: failed` queues sleep and does not tear down.
- [ ] Attention-expiry tests: already-asleep session stays wakeable (no `failSession`); live session queues sleep; not-preservable still cleans up.
- [ ] Control tests: Archive (`destructiveSessionEnd`) and task DELETE still tear down immediately for a `failed` task; parent stop stays `cancelled` + destructive.
- [ ] Node-cleanup tests (real SQL): failed + chat session is not reaped; failed without chat, and cancelled, still reaped (discriminating).
- [ ] Classifier/cancel/drain tests for `failed`, plus a `cancelled` control (not widened).
- [ ] Exhaustion fallback test: exhausted failed preservation tears down and surfaces; exhausted completed task is unchanged.
- [ ] Docs: update public docs that describe failed-task cleanup/sleep behavior.
- [ ] Cost note (rule 76): `pnpm quality:cloudflare-cost` baseline + incremental R2 estimate in PR.
- [ ] Follow-up ideas: UI `wakeAttemptFailed` proxy; kill-switch preservation; append transcript-only evidence to `01M04SB5QS0ASYKDSZR8FFSY38`.
- [ ] Staging: a real failed task on a VM with an uncommitted file ends sleeping with a snapshot; wake restores the file; clean up.

## Acceptance criteria

- A task that fails through any "preserve" path, while its runtime is live, ends with a snapshot-backed sleeping workspace. Its ProjectData session is `sleeping` and a follow-up message wakes it. Staging verifies this on a VM.
- A failure on an already-sleeping conversation leaves it `sleeping` and wakeable.
- When preservation is impossible or exhausted, the workspace is still torn down (bounded) and the chat shows a clear system message that work was not preserved. A degraded capture is surfaced as well.
- Archive, Delete, and parent-stop paths still tear down immediately. Parent-stopped tasks stay `cancelled`.
- Failed-task snapshots use the standard 7-day retention; no new retention path.

## References

- Rules: 58, 66, 61, 44, 62, 67, 47, 18 (scoped copies under `apps/api/.claude/rules/`)
- `apps/api/src/services/task-terminal-cleanup.ts`, `task-runner.ts`, `session-sleep.ts`, `task-sleep-preservation.ts`
- Policies: `a3780107`, `486d1dd1`, `e8897480`, `d08d64dc`, `a974b04f`, `2adacc8f`
