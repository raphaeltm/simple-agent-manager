# TaskRunner / D1 lifecycle reconciliation

## Problem

TaskRunner Durable Objects mark orchestration complete after handing an agent a running workspace, while D1 remains active until an external completion path. `recoverStuckTasks()` only logs DO-completed/D1-active mismatches, so dead conversation work can remain `in_progress` / `awaiting_followup` until the eight-hour hard timeout. Fix this promptly without terminating genuinely running long work, and close the `aborted_by_recovery` interleaving.

## Production evidence (2026-07-11)

- Read-only production queries found 57 DO-completed/D1-active warnings and 37 `awaiting_followup` hard-timeout warnings since June 1.
- All 34 D1 rows with the exact 480-minute failure since June 1 were conversation mode and now have deleted/missing workspaces; 32 retain `agent_sessions.status='running'`, proving that status is stale liveness.
- The June 22–29 cohort has seven rows (the six reported plus one June 29), all conversation mode with deleted workspaces and sessions still marked running.
- Observability showed completed DOs and healthy shared nodes. Soft-timeout skips used node heartbeat, which proves host—not task—liveness.
- No bounded-window `aborted_by_recovery` evidence appeared. Normal post-handoff liveness drift is dominant, but the code-grounded race still needs correction.

## Research findings

- `stuck-tasks.ts` uses node heartbeat alone for grace, logs mismatch informationally, performs per-candidate dedupe I/O, and mixes `updated_at` diagnostic elapsed time with `started_at` execution time.
- `state-machine.ts` completes the DO after handoff. A zero-row delegated-to-in-progress update completes it without re-reading/repairing D1.
- Task-mode `awaiting_followup` is non-terminal pending explicit `complete_task`; conversation-mode completion intentionally remaps there.
- `task-terminal-cleanup.ts` centralizes session/workspace cleanup after D1 is terminal.
- Priority 2 `01KX8SWC9DEMHCA8RSPZN5W1V1` may alter crash recovery. Rebase after it lands and preserve recoverable `awaiting_followup`.

## Implementation checklist

- [x] Add a bounded task-liveness probe correlating workspace state, task-scoped agent-session freshness, and node heartbeat; shared-node heartbeat is never sufficient alone.
- [x] Keep thresholds and per-run candidate/I/O limits configurable with shared `DEFAULT_*` constants and environment fallbacks.
- [x] Promptly reconcile DO-completed+D1-active work only when composite liveness proves workspace/agent gone, with sanitized context and a clear terminal state.
- [x] Preserve live long-running task/conversation sessions and priority 2 recoverable `awaiting_followup`.
- [x] Cover queued, delegated, in_progress, and awaiting_followup status/step semantics with task/conversation distinctions.
- [x] Close `aborted_by_recovery` by re-reading D1 and ensuring it is terminal before DO completion without overwriting a concurrent legitimate terminal callback.
- [x] Make repeated same-terminal callbacks idempotent and reuse terminal cleanup; remaining cross-path verification is tracked below.
- [x] Correct diagnostic timing and bound control-loop candidates, ACP-session reads, and observability dedupe lookups.
- [x] Add unit and cross-runtime regressions for recovery interleaving, callback idempotency, dead mismatch, and live negative behavior.
- [x] Update public docs/environment references for new configuration.
- [x] Integrate current main and preserve—not duplicate—its recovery behavior. (Merged current `origin/main` on 2026-07-16; recovery remains first in the five-minute operational sweep.)
- [x] Run focused/full validation, control-loop checks, and Cloudflare/security/constitution/test/docs-sync/control-loop/task-completion reviews. (See "Review fixes" below.)
- [ ] Wait for staging turns 1–4 and unrelated deployments, query staging state/logs, deploy, and verify.
- [ ] Open PR (#1567), pass CI, merge, monitor production deploy/evidence, and update idea `01KT90PKF6167SXZ9YZY0R26MM`. (PR open; CI/staging/merge pending.)

## Review fixes (2026-07-11, local specialist reviewers on PR #1567)

Constitution: PASS. Cloudflare + task-completion: FAIL with confirmed real bugs in
the recovered work, all fixed:

1. `awaiting_followup` is a `TaskExecutionStep`, NOT a `TaskStatus`
   (`packages/shared/src/types/task.ts`; writers set `execution_step`, never
   `status` — `task-tools.ts:264`, `callback.ts:157`). Removed the dead
   `status='awaiting_followup'` candidate-query OR (which also defeated the index),
   switch case, `fromStatus` cast, `failedInProgress` counter case, and
   diagnostic-timing branch. Real production rows are `in_progress` +
   `execution_step='awaiting_followup'`, still handled by the `in_progress` case.
2. Rule 47: added `TASK_LIVENESS_PROBE_TIMEOUT_MS` (default 5s) bounding the
   ProjectData DO liveness probe; a timeout is inconclusive (fail-safe), never
   fatal. Cached the per-candidate liveness result so the in_progress gate and the
   DO-mismatch gate probe at most once.
3. Two pre-existing workers-pool tests were silently broken by the code change and
   never caught because the workers pool does not run in CI (see backlog
   `2026-07-11-workers-pool-tests-not-run-in-ci.md`). Fixed both assertions; the
   live-skip vertical slice is deferred to that backlog task. The existing Worker
   D1/DO reconciliation slice runs successfully in the rescue worktree.
4. Added CI-verified node-pool regressions: a live task-mode `awaiting_followup`
   task is preserved; state-machine `aborted_by_recovery` Branch 1 (concurrent
   recovery advanced D1 to `in_progress` → DO completes as running, no `failTask`).
5. Fixed lint (import sort). Documented the liveness-gated recovery semantic
   (live tasks are preserved past the hard ceiling) in `configuration.md`.

## Staging failure and follow-up (2026-07-12)

- The original PR branch deployed successfully and passed browser/API regression checks, but a controlled one-row D1 mismatch remained `in_progress` across three five-minute cron boundaries while its workspace was `deleted`.
- `TaskRunner.completed` records successful orchestration handoff, not later agent completion. A missing/unreachable TaskRunner state must therefore remain diagnostic evidence; it cannot veto reconciliation when task-scoped runtime liveness is conclusively dead.
- Recovery now runs first in the five-minute operational sweep, before provisioning, migration, and node-cleanup phases can fail and suppress it.
- TaskRunner status probes are bounded and classified as `ok`, `missing`, `timeout`, or `error`; cron summaries expose missing/error/reconciled counters.
- A superadmin-only, read-only diagnostics endpoint reports the exact eligibility, liveness, TaskRunner probe, and decision for one task before any staging mutation.
- Unit coverage proves missing/error TaskRunner RPC outcomes still reconcile a deleted runtime. A Worker D1/DO vertical slice also asserts the second sweep is a no-op and passed locally on 2026-07-16.
- The follow-up staging mismatch was correctly classified as `reconcile_dead_runtime` but remained active across the 16:30 and 16:35 UTC sweeps. The bounded query always reread the same 100 oldest active rows, so live/inconclusive historical rows could permanently starve later dead rows.
- Recovery now persists a configurable KV scan cursor, starts a cursorless rollout at the newest bounded page, resumes after the prior page, and wraps fairly. Cron summaries expose scan count/cursor state/errors, and the read-only endpoint reports whether and where the next page selects the inspected task.

## Acceptance criteria

- Demonstrably dead DO-completed+D1-active work reaches terminal D1 promptly with sanitized diagnostics.
- Concrete live workspace/agent evidence prevents early failure below the configurable absolute runaway-cost ceiling.
- Shared-node heartbeat and stale running session status cannot independently suppress reconciliation.
- Recovery/callback interleavings converge on one terminal state with idempotent side effects.
- Task/conversation awaiting-followup semantics remain intentional.
- Control-loop work is bounded/configurable with shared defaults.
- Cross-runtime tests and all review, CI, staging, merge, and production gates pass.

## References

- Idea `01KT90PKF6167SXZ9YZY0R26MM`
- Priority 2 `01KX8SWC9DEMHCA8RSPZN5W1V1`
- `apps/api/src/scheduled/stuck-tasks.ts`
- `apps/api/src/durable-objects/task-runner/state-machine.ts`
- `apps/api/src/routes/tasks/callback.ts`
- `apps/api/src/services/task-terminal-cleanup.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/32-cf-api-debugging.md`
- `.claude/rules/35-vertical-slice-testing.md`
