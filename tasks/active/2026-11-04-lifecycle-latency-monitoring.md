# Lifecycle Latency Monitoring

## Problem

On 2026-11-03 every VM workspace stop took ~31 minutes for six days, and nothing automated noticed
(fixed in #2516, `tasks/archive/2026-11-03-fast-workspace-physical-deletion.md`). Raphaël asked for
lifecycle systems to be measured and evaluated regularly, with slowness flagged automatically to
this project. Idea `01M6HS335G8J4P423NY2MYTQCJ`.

## Research Findings

- **Timings are log-only.** `recordLifecycleTimings` (`apps/api/src/services/lifecycle-timings.ts`)
  and `recordRunnerPhase` only call `log.info`.
- **No state-entry timestamp exists.** `workspaces.updated_at` is rewritten on every deletion retry
  (`persistDeletionDiagnostic`), so state age cannot be measured. There is no transition history for
  workspaces or nodes; `task_status_events` exists for tasks only.
- **Status writers are scattered** across routes, DOs, services and sweeps (rule 44). A D1 trigger
  records every transition at the storage layer instead. D1 triggers are already used
  (`0167_capacity_pool_max_nodes.sql`), and Workers tests apply real migrations
  (`vitest.workers.config.ts`), so trigger behavior is testable.
- **Alert path exists and is live in production.**
  - `persistError` writes to `platform_errors`.
  - The hourly `runPlatformFeedbackTriage` groups warn and error rows by normalized signature, then
    creates ideas and incidents in the feedback project.
  - `runIncidentTriggerSweep` dispatches the matching trigger.
  - Production (queried 2026-11-04): `feedback.projectId` is the SAM project, and the active trigger
    is `01M0Y4KTQAVKTG7VVWNWXD89Y8` "SAM private incident triage".
- **Watchdogs today catch failures and hard timeouts only.** Examples:
  - `checkProvisioningTimeouts` at 30 minutes.
  - `recoverStuckTasks`.
  - The 24-hour deletion dead-letter.

  Nothing checks latency, and `log.warn` is not persisted.

- **Runtime tunables go in the admin settings registry** (rule 07,
  `apps/api/src/services/admin-settings-*-definitions.ts`), read via `resolveAdminSettingDetailsMany`.
- **Cron structure.** The 5-minute sweep list in `apps/api/src/scheduled/handler.ts` uses
  `createSweepIsolator`. The daily `0 3 * * *` branch runs analytics forward and the audit purge.
- **Statuses.**
  - Workspaces and nodes: `pending`, `creating`, `recovery` and `stopping` are transient.
  - Session sleep (`session_snapshots.sleep_status`): `preparing` and `stopping` are transient.
  - Session recovery (`recovery_status`): `waking` is transient.
  - Production has 17 `waking` rows. They may be stale and will be surfaced once (capped and grouped).
- **The post-migration row-count gate needs a churn entry** for the new history table, because it
  is purged by retention (`scripts/deploy/d1-migration-churning-tables.ts`).

## Design Change After Staging (2026-11-04)

The first design used D1 triggers on the status tables. Staging showed D1 counts trigger writes in
`meta.changes` (`changes: 3` for a one-row status update), which broke every `changes === 1`
compare-and-set on those tables: `provisionNode` destroyed each VM it had just created. The
triggers were dropped (`0219_drop_lifecycle_status_triggers.sql`), the draft `0218` was removed
(never applied in production; staging keeps its orphan columns and two empty tables), and the
watchdog now samples states instead (`0220_lifecycle_state_observations.sql`). A workers test
guards the `changes === 1` invariant for one-row status updates on these tables, and
`apps/api/.claude/rules/31-migration-safety.md` records the lesson.

The full local workers suite timed out before staging was deployed, and staging was deployed
anyway; the suite would have caught this. Do not deploy to staging before the workers suite has a
verdict, locally or in CI.

## Original Design (superseded where it says triggers)

1. **Migration** (one file, all additive):
   - Columns `workspaces.status_changed_at`, `nodes.status_changed_at`,
     `session_snapshots.sleep_status_changed_at` and
     `session_snapshots.recovery_status_changed_at`.
   - Table `lifecycle_state_transitions`: entity type, entity id, from/to status, from-entered-at,
     changed-at.
   - Table `lifecycle_latency_alerts`: one row per alerted episode, with an
     `(entity_type, entity_id, status, entered_at)` primary key.
   - `AFTER UPDATE OF <status column>` triggers that insert a transition and stamp the changed-at
     column.
   - `AFTER INSERT` triggers that stamp the initial changed-at.
   - A backfill for non-terminal rows.
2. **Watchdog** (`lifecycle_latency_watchdog`, every 5 minutes):
   - One bounded SELECT per table for rows past their state's budget, oldest first.
   - `INSERT OR IGNORE` an alert row per episode.
   - On a new insert, call `persistError(level 'warn')` with a stable message per entity and state,
     so triage groups them into one signature.
   - The per-tick cap is disclosed in the log (rule 65).
3. **Daily evaluation** (`0 3 * * *`):
   - Per watched state, compute p50, p95 and max over 24 hours from the transitions, and p95 over the
     prior 7 days.
   - Flag a regression with `persistError` when p95 exceeds the budget, or exceeds the regression
     factor times the baseline, given enough samples.
   - Always log a summary.
   - Purge transitions and alerts past retention, in bounded batches.
4. **Settings** (Operations group):
   - One budget in minutes per watched state.
   - Alerts per tick, regression factor, minimum samples and retention days.

## Implementation Checklist

- [x] Migration `0218_lifecycle_latency_monitoring.sql` and drizzle schema additions
- [x] Churning-table entry for `DATABASE.lifecycle_state_transitions` and `DATABASE.lifecycle_latency_alerts`
- [x] Admin settings: `lifecycleLatency.*` definitions and name typing
- [x] `services/lifecycle-latency/` holding the watched-state config, the watchdog and the daily evaluation
- [x] Wire the watchdog into the 5-minute sweep and the evaluation into the daily cron
- [x] Workers tests with real migrations covering:
  - trigger stamping and history
  - the watchdog alerting once per episode
  - a new episode alerting again
  - no alert under budget (liveness)
  - all four entity kinds
  - defaults resolved through the real settings resolver
  - daily regression detection, including min-samples and baseline controls
  - retention purge
- [x] Discrimination proofs, reverting each guard once
- [x] Docs: lifecycle latency monitoring section and the settings in the admin settings guide
- [ ] `pnpm quality:migration-safety`, `pnpm quality:runtime-tunables`, lint, typecheck and tests

## Acceptance Criteria

- [ ] A workspace held in `stopping` past its budget produces exactly one `platform_errors` warn row
      per episode. The row lands in the next watchdog tick, through the real trigger-maintained
      timestamp.
- [ ] A new stop episode for the same workspace alerts again; a state under budget never alerts.
- [ ] Every status transition on workspaces, nodes and session sleep/recovery is recorded with its
      duration, and no status writer changes.
- [ ] The daily evaluation flags a synthetic 3× regression and stays quiet below the sample minimum.
- [ ] Budgets and limits are admin settings, with defaults exercised through the real resolver.
- [ ] Staging: a forced slow state produces a `platform_errors` row and the transitions are recorded.
- [ ] Production: deploy verified, and the first watchdog ticks' output checked.

## References

- `.claude/rules/81-work-bounds-must-state-throughput.md`
- `apps/api/.claude/rules/47-control-loop-io-budget.md`,
  `apps/api/.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`,
  `apps/api/.claude/rules/31-migration-safety.md`, `apps/api/.claude/rules/65-capped-selection-must-rank-and-disclose.md`
- Idea `01M6HS335G8J4P423NY2MYTQCJ`
