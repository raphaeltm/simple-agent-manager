# Rollout-aware incident reopen suppression and dispatch attempt hygiene

## Problem

Production private incident triage is redispatching work that should stay closed:

- Signature `2bcdc854e38c7a0f` was dispatched three times even though later dispatches used occurrences that predated its merged vm-agent fix in PR #1924.
- Signature `c92773d839c7af76` reopened seven minutes after resolution during deploy-induced Durable Object reset churn.
- A platform-side false kill (`task_acp_session_not_live`) consumed one of the signature's bounded dispatch attempts even though the triage task never reported its own failure.

Idea: `01M0YGMRX9BBMBENPKKBGKV769`
SAM task: `01M0YGT4MPYKNS36GBJAETKAE1`

## Research findings

- `apps/api/src/services/platform-feedback-triage.ts` updates `platform_feedback_triages.queue_state` from `resolved`/`expired` to `pending` for any grouped row in the current lookback window. The SQL does not compare the new occurrence timestamp with `resolved_at`, so old platform errors can reopen a fixed signature.
- `markIncidentPending()` and `upsertUserReportIncident()` in `apps/api/src/services/platform-feedback-incidents.ts` have the same unconditional terminal-state reopen pattern.
- The platform error rows already carry `node_id`, and VM nodes already persist heartbeat-reported build identity in `nodes.agent_version` (`VM_AGENT_REQUIRED_VERSION` compatibility machinery from rule 54). `runPlatformFeedbackTriage()` can query the main D1 by `node_id` after reading observability rows because D1 databases cannot be joined directly.
- There is no structured fix-resolution contract yet; sibling idea `01M0YGMAZTZ01Y0ESREF2AMVNC` tracks explicit fields. For this task, rollout suppression must use the currently available data: `source='vm-agent'`, resolution note/task PR evidence, `VM_AGENT_REQUIRED_VERSION`, occurrence `node_id`, and `nodes.agent_version`.
- `reserveIncidentDispatch()` increments `dispatch_attempts` when it leases a pending incident. That means later platform-side task death consumes an attempt before any agent-reported failure exists.
- `reclaimExpiredIncidentDispatches()` currently decides only by the already-incremented attempt count. It does not inspect linked task status events, task error messages, or trigger execution status to distinguish platform-side death from an agent-reported failed task.
- Rule 47 applies: this is a scheduled control loop. Candidate volume remains bounded by the incident trigger summary/dispatch limits; every selected dispatch lease must have an exit path, and platform/capacity failures should be retryable markers rather than terminal agent failure.
- Rule 28/35/62 require real SQL and discriminating trigger-path regression tests. Existing `platform-feedback-triage.test.ts` and `platform-feedback-incidents.test.ts` use `better-sqlite3` through `createSqliteD1`, which is suitable for the required SQL predicates.
- Rule 27/54 mean Worker deploys do not update already-running VM binaries. For vm-agent-sourced signatures resolved with a fix reference, stale node builds must not reopen; a current-build occurrence is the positive control.

## Implementation checklist

- [ ] Add `DEFAULT_PLATFORM_FEEDBACK_INCIDENT_REOPEN_COOLDOWN_MS` and wire `PLATFORM_FEEDBACK_INCIDENT_REOPEN_COOLDOWN_MS` through shared exports, `Env`, incident config, `.env.example`, and public configuration docs.
- [ ] Extend platform-feedback triage row loading and observability row grouping to carry occurrence `node_id` and heartbeat-derived `agent_version` metadata.
- [ ] Add a shared reopen decision helper that requires terminal incident occurrences to be newer than the terminal timestamp plus cooldown.
- [ ] Apply the reopen helper in `runPlatformFeedbackTriage()` so old/cooldown/stale-vm-agent occurrences update bounded metadata but do not queue, diagnose, or dispatch closed signatures.
- [ ] Apply the same terminal reopen policy to `markIncidentPending()` and `upsertUserReportIncident()` so direct incident paths cannot bypass the gate.
- [ ] Change dispatch attempt accounting so reservation does not consume an attempt; expired dispatch reclamation increments attempts only for agent-reported failed tasks.
- [ ] Treat platform-side dispatch deaths (`task_acp_session_not_live`, `workspace_deleted`, provisioning/startup failures, missing task boundary) as release/requeue without incrementing `dispatch_attempts`.
- [ ] Add discriminating real-SQL tests:
  - [ ] old occurrence predating `resolved_at` stays resolved and a newer occurrence reopens;
  - [ ] occurrence inside `PLATFORM_FEEDBACK_INCIDENT_REOPEN_COOLDOWN_MS` stays resolved and post-cooldown occurrence reopens;
  - [ ] vm-agent occurrence from a stale node build stays resolved and current-build occurrence reopens;
  - [ ] platform-side expired dispatch release preserves `dispatch_attempts`, while workspace-callback failed task consumes one attempt.
- [ ] Update existing incident trigger tests for the new attempt-accounting point.
- [ ] Run focused tests and full quality gates.
- [ ] Run required specialist reviews: task-completion-validator, cloudflare-specialist, env-validator, constitution-validator, and test-engineer.
- [ ] Deploy to staging and verify the backend behavior or document any explicit blocker.
- [ ] Create PR, wait for CI, merge, monitor production deploy, then update idea `01M0YGMRX9BBMBENPKKBGKV769` with the merged PR link.

## Acceptance criteria

- [ ] A resolved/expired signature is not reopened by an occurrence at or before its terminal timestamp.
- [ ] A resolved/expired signature is not reopened by an occurrence inside the configured reopen cooldown window.
- [ ] A vm-agent signature resolved with a fix reference is not reopened by occurrences from nodes whose `agent_version` does not match the current required vm-agent build.
- [ ] A current-build vm-agent occurrence after the cooldown still reopens, proving the rollout guard is discriminating.
- [ ] Platform-side task deaths release incident dispatch leases without increasing `dispatch_attempts`.
- [ ] Agent-reported failed tasks consume bounded dispatch attempts and can still reject after the configured max.
- [ ] Regression tests exercise production service entry points against a real SQLite-backed D1 adapter.
- [ ] Env var documentation and examples match code.
- [ ] PR includes control-loop load/escape-path notes and specialist review evidence.

## References

- `apps/api/src/services/platform-feedback-triage.ts`
- `apps/api/src/services/platform-feedback-incidents.ts`
- `apps/api/src/services/platform-feedback-incident-config.ts`
- `apps/api/src/scheduled/incident-triggers.ts`
- `apps/api/tests/unit/services/platform-feedback-triage.test.ts`
- `apps/api/tests/unit/services/platform-feedback-incidents.test.ts`
- `apps/api/tests/unit/scheduled/incident-triggers.test.ts`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/67-shared-predicates-that-trigger-actions.md`
