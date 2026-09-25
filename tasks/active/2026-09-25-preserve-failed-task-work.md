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
  at _sleep_ time (a transcript-only snapshot, about a day before the failure), not at failure
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

| Path                                                                             | Entry point                                                                                                                             | Runtime                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| VM-agent failure callback (`Agent prompt failed`: provider errors, usage limits) | `routes/tasks/callback.ts` → `cleanupTerminalTaskResourcesOrThrow`                                                                      | VM + cf-container (the standalone agent posts the same callback) |
| User/API status → `failed`                                                       | `routes/tasks/crud.ts POST /:taskId/status` → `cleanupTerminalTaskResourcesOrThrow`                                                     | both                                                             |
| Explicit run cleanup of a failed run                                             | `routes/tasks/run.ts POST /:taskId/run/cleanup` → `cleanupRequestedTaskRun` (failed only; completed/cancelled keep the direct teardown) | both                                                             |
| Human-input expiry                                                               | `attention-expiry.ts failExpiredTaskMarker (needs_input)`                                                                               | both                                                             |
| SAM check-in expiry                                                              | `attention-expiry.ts failExpiredTaskMarker (reconciliation_checkin)`                                                                    | both                                                             |

**Keep the existing sleep.** The conversation is already asleep or its sleep is in flight: any
failure path above, when `loadTaskSleepPreservation` reports `preserve`. This is the same
predicate the resumer reads (rule 58).

**Released with a notice (cannot be preserved by sleep).** A fatal agent error (prompt timeout,
unrecoverable crash) makes the VM agent report `error` activity, which sets
`agent_sessions.status = 'error'`, alongside the failure callback. The sleep path needs a
resumable agent session to hibernate, so whichever lands first, the runtime is torn down and the
chat says so: at failure time (`no_resumable_agent_session`), or by the sweep's
`releaseStalledFailedTaskPreservation` when the error lands after the sleep was queued. The
same release fires when the sleep is still waiting `FAILED_TASK_PRESERVATION_MAX_WAIT_MS`
(default 8 hours) after the failure (`preservation_timed_out`). A SAM check-in that expires
with the agent still mid-turn past the watchdog's hard ceiling is released at once
(`agent_unresponsive`): the turn will not end, and a sleep would only wait on it.

**Readers that must agree with preservation (not entry points):** the terminal-session ledger
reconciler (`terminal-session-reconciliation.ts`) defers while `findRestorableOrInFlightSleepSnapshot`
sees the queued intent, past the completion-drain window; covered by
`tests/workers/completion-response-drain.test.ts`.

**Destructive by design (control).** These paths express explicit intent:

| Path                 | Entry point                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| Archive/Stop session | `routes/chat-stop.ts` (`destructiveSessionEnd: true`, even when the task already `failed`)                |
| Delete task          | `routes/tasks/crud.ts DELETE` (`cancelled` + `destructiveSessionEnd`)                                     |
| Parent stop          | `routes/mcp/orchestration-comms.ts`, `sam-session/tools/stop-subtask.ts` (`cancelled`, policy `486d1dd1`) |

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

- [x] Add `failed-task-preservation.ts` with the decision, degraded surfacing, and exhaustion/degraded-capture hooks.
- [x] Add a named sleep-owned terminal-status authority; consume it in `classifySessionIdleness`, `cancelScheduledSessionSleep`, `isCompletingSessionProtected`, and node-cleanup Phase 0 + Phase 4. Refinement: the reapers leave a failed task's workspace alone only while an agent session can be slept (`sleepLifecycleOwnsTerminalTaskWorkspaceSql`), so the rule-47 escape for unclaimable workspaces survives (the pre-existing recovery-workspace test proved it).
- [x] Route `cleanupTerminalTaskResources` failed (non-destructive) through preservation.
- [x] Route attention expiry (both kinds) through preservation; `stopWorkspace: false`.
- [x] Sleep sweep: exhaustion fallback + degraded-capture note for failed tasks.
- [x] Unit tests: decision outcomes (live VM, live cf-container, already asleep, unknown, each not-preservable reason). `tests/unit/services/failed-task-preservation.test.ts` (27, real SQLite; project predicate deletion verified red).
- [x] Vertical slice (rule 62): failed task with a dirty live workspace, driven from `cleanupTerminalTaskResources` through the real sleep sweep, ends with a verified snapshot, a sleeping workspace, and ProjectData `sleeping` (never `failed`). A real SQL engine drives the D1 state. `tests/integration/failed-task-preservation.test.ts`: also the resumer claim gate accepts it; 4 incident tests red on surgical pre-fix revert.
- [x] Route-level test: VM callback `toStatus: failed` queues sleep and does not tear down. `tests/unit/routes/task-callback-failed-preservation.test.ts` (real SQL, idempotent repeat); red pre-fix.
- [x] Attention-expiry tests: already-asleep session stays wakeable (no `failSession`); live session queues sleep; not-preservable still cleans up. Plus lookup-failure withholds; all 4 red pre-fix.
- [x] Control tests: Archive (`destructiveSessionEnd`) and task DELETE still tear down immediately for a `failed` task; parent stop stays `cancelled` + destructive. The Archive control is in both the ordering unit test and the vertical slice. Task DELETE uses the same `destructiveSessionEnd` branch. `cancelled` keeps its path, and the cancelled controls in the classifier, fence and reaper tests prove it was not widened.
- [x] Node-cleanup tests (real SQL): failed + chat session is not reaped; failed without chat, and cancelled, still reaped (discriminating). The workers suite covers both phases, and discrimination was verified both ways: pre-fix → 2 red; an unconditional failed exemption → 3 red, including the pre-existing recovery-workspace escape test.
- [x] Classifier/cancel/drain tests for `failed`, plus a `cancelled` control (not widened). Each is red pre-fix; the controls stay green.
- [x] Exhaustion fallback test: exhausted failed preservation tears down and surfaces; exhausted completed task is unchanged.
- [x] Docs: update public docs that describe failed-task cleanup/sleep behavior (`architecture/overview.md`, `guides/chat-features.md`, `reference/configuration.md` `SESSION_SLEEP_AFTER_MS`).
- [x] Cost note (rule 76): `pnpm quality:cloudflare-cost` baseline + incremental R2 estimate in PR.
- [x] Follow-up ideas: UI `wakeAttemptFailed` proxy (01M3BVZYGE7AAKQZDYCM7PXJ7N); kill-switch preservation (01M3BVZR6AZ0S4F5Q2JRKSEX09); late execution-step callback clears a failed task's error (01M3BVZH8GCR2KXH19KFPX5D86); completed-task exhausted sleep (01M3BW047BN1SPA3YBQ68SV4T8); transcript-only evidence appended to `01M04SB5QS0ASYKDSZR8FFSY38`.
- [x] Review round 1 fixes (see the table above): one authority for the claimer's preconditions and the chat→task join; fresh sleep episode on failure with a verified intent; reaper ownership mirrors the claimer and releases exhausted sleeps; sweep releases unclaimable and budget-spent preservations; failed tasks drain from the failure (reverted in round 2); repair accepts a `failed` session; deterministic notice ids; incomplete-snapshot note on the already-asleep path with Instant wording; explicit run cleanup through preservation; step reports keep a failed task's error; docs.
- [x] Review round 1 tests, each proven discriminating by a surgical revert: unit preservation (43), authority TS/SQL agreement + ownership matrix (28), idleness drain rules, repair, route wiring (run/cleanup, status, Archive of a failed task, step report), integration (stale budget, error race, selection-time exhaustion via `waitUntil`, hung prompt + completed control, both runtimes), workers reapers (backstop at both phases), workers reconciler deferral, workers real-alarm self-RPC notice.
- [x] Review round 2 fixes (see the round 2 table): drain follows activity again; mid-turn check-in expiry released as `agent_unresponsive`; `FAILED_TASK_PRESERVATION_MAX_WAIT_MS`; repair's `failed` acceptance scoped to failed tasks; in-flight predicate bounded by the sleep budget; chat-scoped notice ids; reset-before-queue; compare-and-set exhaustion and release writes; exhaustion counts attempts; guarded note; docs.
- [x] Review round 2 tests, each proven discriminating by a surgical revert: release CAS interleave, maximum wait (unit + real sweep), guarded note, follows-activity drain (unit + real sweep), mid-turn check-in release (prompt and harness work) with an idle control, selection-time exhaustion CAS interleave, in-flight predicate bound (new file), reaper exhaustion by attempts with a still-retrying control and the configured budget threaded through Phase 4, repair scoping.
- [ ] Staging: a real failed task on a VM with an uncommitted file ends sleeping with a snapshot; wake restores the file; clean up.

## Review round 1 (2026-09-25): findings and dispositions

Seven local reviewers ran. Every finding below is fixed in the branch unless marked otherwise.

| Reviewer                                      | Finding                                                                                                                                                                                 | Disposition                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| lifecycle (adversarial)                       | HIGH F1: a fatal agent error racing the failure callback left a queued sleep the sweep deferred forever; the reaper then stopped the VM with no notice, and the session stayed `active` | Fixed: `releaseStalledFailedTaskPreservation` (sweep deferral branch) + reaper predicate mirrors the claimer                                   |
| lifecycle                                     | F2: a hung prompt re-reports `prompting` every minute, so the drain anchored on activity never ended                                                                                    | Round 1 drained failed tasks from the failure; that regressed a working agent (round 2 H1) and was replaced, see round 2                       |
| lifecycle                                     | F3: degraded / mid-capture rows retry past the budget forever                                                                                                                           | Fixed: a failed task's release fires once `sleep_attempts >= SESSION_SLEEP_MAX_ATTEMPTS`                                                       |
| lifecycle, test-engineer                      | F4 / HIGH: `sleep_queued` was reported without checking an intent was written; a budget spent by an earlier sleep ended preservation with zero attempts                                 | Fixed: failure starts a fresh episode (`resetAttempts`), and `scheduleSessionSnapshotSleep` now reports whether it wrote                       |
| lifecycle                                     | F5: a terminal reconciler could fail a preserved session, then the sleep jammed at `stopping`                                                                                           | Fixed: the lifecycle repair also finishes teardown for a `failed` ProjectData session                                                          |
| lifecycle                                     | F6: an incomplete snapshot was not noted on the already-asleep path (8 of 9 production cases)                                                                                           | Fixed: noted at failure time                                                                                                                   |
| lifecycle                                     | F7: expired degraded sleeping snapshots are never purged (pre-existing; 174 in production)                                                                                              | Deferred: evidence appended to existing idea `01M05HTJHCWXCG5YZJ6TB3Y2AG`; widening a destructive purge deserves its own change                |
| lifecycle                                     | F8: an incomplete Instant snapshot can never be restored, yet the note said "when it wakes"                                                                                             | Fixed: Instant wording                                                                                                                         |
| lifecycle                                     | F9: a transient queue error tears down instead of relying on the reconciler                                                                                                             | Kept deliberately: teardown is bounded and visible; withholding would have no bound for a persistent error                                     |
| lifecycle                                     | F10: terminalized missing-source rows skipped the release; notices could repeat                                                                                                         | Fixed: settle after `terminalizeMissingSleepSource`; per-task deterministic notice ids                                                         |
| lifecycle                                     | F11: a late step report clears a failed task's error (idea `01M3BVZH8GCR2KXH19KFPX5D86`)                                                                                                | Fixed: the step-only callback keeps a failed task's `error_message`                                                                            |
| task-completion-validator                     | HIGH: `POST /:taskId/run/cleanup` bypassed preservation                                                                                                                                 | Fixed: `cleanupRequestedTaskRun`                                                                                                               |
| task-completion-validator                     | MEDIUM: terminal-session reconciler vs a queued intent untested                                                                                                                         | Fixed: workers test                                                                                                                            |
| cloudflare-specialist                         | HIGH: floating teardown promise in the DO alarm, and the lost durable `stopped` backstop                                                                                                | `waitUntil` premise refuted by Cloudflare docs ("`waitUntil` has no effect in Durable Objects"); backstop fixed by the reaper ownership mirror |
| cloudflare-specialist                         | MEDIUM: self-RPC notice untested at runtime fidelity                                                                                                                                    | Fixed: `tests/workers/attention-expiry-failed-task-preservation.test.ts`                                                                       |
| cloudflare-specialist                         | LOW: one extra read per claimed sleep                                                                                                                                                   | Accepted: bounded by the batch size, off the critical path                                                                                     |
| architecture-reviewer                         | HIGH: a fourth copy of the chat→task ownership join                                                                                                                                     | Fixed: `session-sleep-task-owner.ts`, used by all four sites                                                                                   |
| architecture-reviewer, constitution-validator | Duplicated status lists; ownership SQL not derived from the authority                                                                                                                   | Fixed: shared claimer constants; `Record<status, rule>` ownership                                                                              |
| doc-sync-validator                            | `overview.md` Notification DO paragraph and `notifications.md` still said the check-in watchdog was destructive                                                                         | Fixed                                                                                                                                          |
| test-engineer                                 | `terminal_failed`, selection-time exhaustion, Archive of a failed task, status route, both runtimes, check-in + already-asleep                                                          | Fixed: tests added                                                                                                                             |

## Review round 2 (2026-09-25): focused re-review of the round 1 fixes

One adversarial reviewer re-read the fix batch. It confirmed F1, F3, F4, F6, F8, F10, F11, the run
cleanup, the shared join and the pure move closed, and found:

| Finding                                                                                                                                                                                                                                               | Disposition                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH H1: round 1's drain-from-failure slept a failed agent that was still working. `sleepWorkspaceSession` abandons a capture when activity changes, so each sweep spent an attempt and the budget ended with a teardown mid-turn                     | Fixed: the drain follows activity for failed tasks again, as for completed ones. A hung prompt is bounded by the check-in watchdog (mid-turn release, `agent_unresponsive`) and by `FAILED_TASK_PRESERVATION_MAX_WAIT_MS` (`preservation_timed_out`, rule 47) |
| MEDIUM M1: the repair accepted a `failed` ProjectData session for every task, and the in-flight predicate bounded a failed sleep by the wake budget (3) rather than the sleep budget (9), so reapers could take a runtime the sweep would still retry | Fixed: repair accepts `failed` only for a failed task; `sleepLifecyclePredicateBindings` binds `SESSION_SLEEP_MAX_ATTEMPTS` for every consumer of the predicate                                                                                               |
| MEDIUM M2: notice ids collide when a failed task is re-run in a new chat (message ids are global)                                                                                                                                                     | Fixed: `failedTaskNoticeId(kind, taskId, chatSessionId)`                                                                                                                                                                                                      |
| MEDIUM M3: a claimable runtime whose session state never resolves defers forever                                                                                                                                                                      | Fixed: the maximum wait                                                                                                                                                                                                                                       |
| LOW L1: two-write window between queueing and resetting the budget; the sweep's selection-time exhaustion write had no compare-and-set                                                                                                                | Fixed: reset, queue, then re-verify; the exhaustion write matches the attempts it selected                                                                                                                                                                    |
| LOW L2: the release's episode-ending write was not evidence-based                                                                                                                                                                                     | Fixed: compare-and-set on the status, due time and attempts it read                                                                                                                                                                                           |
| LOW L3: run cleanup's preservation is not caller-scoped, and each call resets the budget                                                                                                                                                              | Documented: only teardown is caller-scoped; a reset is a fresh episode for a fresh failure signal and is bounded by the maximum wait                                                                                                                          |
| LOW L4: "exhausted" ignored `sleep_attempts`, so raising the budget could not re-arm a row                                                                                                                                                            | Fixed: exhaustion requires `sleep_attempts >= SESSION_SLEEP_MAX_ATTEMPTS` in both the TypeScript and SQL forms; the reapers pass the configured budget                                                                                                        |
| LOW L5: the note on the already-asleep path could turn a kept conversation into a 500                                                                                                                                                                 | Fixed: best effort, logged                                                                                                                                                                                                                                    |
| LOW L6: the fatal-error test hand-set only the agent session                                                                                                                                                                                          | Fixed: the test applies the production error fanout (ProjectData session failed, no session state)                                                                                                                                                            |
| LOW L7: the Instant idle-sleep path never calls the release                                                                                                                                                                                           | Accepted: the reapers' ownership mirror and the maximum wait bound it                                                                                                                                                                                         |

## Acceptance criteria

- A task that fails through any "preserve" path, while its runtime is live, ends with a snapshot-backed sleeping workspace. Its ProjectData session is `sleeping` and a follow-up message wakes it. Staging verifies this on a VM.
- A failure on an already-sleeping conversation leaves it `sleeping` and wakeable.
- When preservation is impossible or exhausted, the workspace is still torn down (bounded) and the chat shows a clear system message that work was not preserved. A degraded capture is surfaced as well.
- Archive, Delete, and parent-stop paths still tear down immediately. Parent-stopped tasks stay `cancelled`.
- Failed-task snapshots use the standard 7-day retention; no new retention path. (The
  pre-existing purge gap for degraded snapshots is tracked in idea `01M05HTJHCWXCG5YZJ6TB3Y2AG`.)
- A failed task whose runtime can no longer be slept (fatal agent error, stopped workspace,
  exhausted retries) is torn down with a chat notice and a failed session — never left `active`.
- A failed task whose agent is still working is not slept mid-turn; a turn that never ends is
  bounded by the check-in watchdog and by `FAILED_TASK_PRESERVATION_MAX_WAIT_MS`.

## References

- Rules: 58, 66, 61, 44, 62, 67, 47, 18 (scoped copies under `apps/api/.claude/rules/`)
- `apps/api/src/services/task-terminal-cleanup.ts`, `task-runner.ts`, `session-sleep.ts`, `task-sleep-preservation.ts`
- Policies: `a3780107`, `486d1dd1`, `e8897480`, `d08d64dc`, `a974b04f`, `2adacc8f`

## Implementation notes

- Cancelling a failed agent's prompt was rejected: the VM agent answers a cancel with `awaiting_followup`. A failed task's drain follows activity, like a completed task's, so a working agent is not captured mid-turn (round 2 H1). A hung prompt is bounded twice: a SAM check-in that expires on it past the watchdog's hard ceiling releases the runtime at once, and the sweep releases any preservation still waiting `FAILED_TASK_PRESERVATION_MAX_WAIT_MS` after the failure. The error-clearing callback itself is now fixed in this branch (review F11).
- Known limitation: a fatal agent error (prompt timeout, unrecoverable crash) ends the agent session, and the sleep path needs a live one to snapshot, so that work cannot be preserved; the chat says so. Preserving files without a live agent session would need VM-agent support for a file-only snapshot.
- The ProjectData DO path (attention expiry) loads the preservation module by dynamic import, matching the file's existing pattern. It surfaces through `projectDataService.persistMessage`, a self-RPC; `reconcileTaskWaits` already does the same from this alarm.
- `node-phases.ts` (623 lines) was split first: Phase 0 moved to `terminal-cf-container-phase.ts` as a pure move, in commit 1fe9d7cf8.
- Local results: API unit+integration 10,305/10,305 passing; API lint and typecheck clean.
- Cost (rule 76): R2 storage is 50 GB, steady, projected at $0.60/month over the allowance. Average snapshot size is 33.8 MB (7-day production manifests; max 231.5 MB, cap 256 MiB). Expect about 5 newly preserved failed tasks a week at 7-day retention: roughly 0.17 GB steady state (about 1.3 GB worst case), under $0.05/month.
