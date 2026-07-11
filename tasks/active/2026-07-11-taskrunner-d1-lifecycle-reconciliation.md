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

- [ ] Add a bounded task-liveness probe correlating workspace state, task-scoped agent-session freshness, and node heartbeat; shared-node heartbeat is never sufficient alone.
- [ ] Keep thresholds and per-run candidate/I/O limits configurable with shared `DEFAULT_*` constants and environment fallbacks.
- [ ] Promptly reconcile DO-completed+D1-active work only when composite liveness proves workspace/agent gone, with sanitized context and a clear terminal state.
- [ ] Preserve live long-running task/conversation sessions and priority 2 recoverable `awaiting_followup`.
- [ ] Cover queued, delegated, in_progress, and awaiting_followup status/step semantics with task/conversation distinctions.
- [ ] Close `aborted_by_recovery` by re-reading D1 and ensuring it is terminal before DO completion without overwriting a concurrent legitimate terminal callback.
- [ ] Make terminal side effects idempotent across cron, DO recovery, and callbacks: event, trigger sync, session state, cleanup, repeated callback.
- [ ] Correct diagnostic timing and bound/deduplicate control-loop I/O.
- [ ] Add unit and cross-runtime Miniflare/D1/DO tests for dead mismatch, live negative case, recovery interleaving, terminal callback/idempotency, and mode/status variants.
- [ ] Update public docs/environment references if configuration changes.
- [ ] Rebase after priority 2 merges and preserve—not duplicate—its recovery behavior.
- [ ] Run focused/full validation, control-loop checks, and Cloudflare/security/constitution/test/docs-sync/control-loop/task-completion reviews.
- [ ] Wait for staging turns 1–4 and unrelated deployments, query staging state/logs, deploy, and verify.
- [ ] Open PR, pass CI, merge, monitor production deploy/evidence, and update idea `01KT90PKF6167SXZ9YZY0R26MM`.

## Acceptance criteria

- Demonstrably dead DO-completed+D1-active work reaches terminal D1 promptly with sanitized diagnostics.
- Concrete live workspace/agent evidence prevents early failure regardless of elapsed duration.
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
