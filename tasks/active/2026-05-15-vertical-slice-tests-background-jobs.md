# Vertical Slice Tests for Background Jobs

## Problem

Background jobs (node-cleanup, stuck-tasks, observability-purge, compute-usage-cleanup, analytics-forward) coordinate multiple systems (D1, DOs, VM agent HTTP, external APIs). Current tests mock away all boundaries with empty stubs, so they don't verify cross-system behavior. Three jobs have zero tests.

## Research Findings

### Source Files
- `apps/api/src/scheduled/node-cleanup.ts` (415 lines) — 5 cleanup phases, uses raw D1 SQL + Drizzle, calls `deleteNodeResources`, `stopWorkspaceOnNode`, `deleteWorkspaceOnNode`, `projectDataService.stopSession`, `persistError`
- `apps/api/src/scheduled/stuck-tasks.ts` (555 lines) — detects stuck tasks via D1, gathers diagnostics, uses optimistic locking, calls `cleanupTaskRun`, `syncTriggerExecutionStatus`, `persistError`
- `apps/api/src/scheduled/observability-purge.ts` (19 lines) — delegates to `purgeExpiredErrors()` on OBSERVABILITY_DATABASE
- `apps/api/src/scheduled/compute-usage-cleanup.ts` (29 lines) — delegates to `closeOrphanedComputeUsage()` which does LEFT JOIN orphan detection
- `apps/api/src/scheduled/analytics-forward.ts` (12 lines) — delegates to `runAnalyticsForward()` which checks enabled flag, reads KV cursor

### Existing Tests
- `apps/api/tests/unit/node-cleanup.test.ts` — shallow: mocks `deleteNodeResources`, `stopWorkspaceOnNode`, `deleteWorkspaceOnNode`, `persistError`, `project-data` service; uses mock D1 with substring matching
- No existing tests for stuck-tasks, observability-purge, compute-usage-cleanup, analytics-forward

### Test Infrastructure
- Miniflare workers pool: `vitest.workers.config.ts` provides real D1 (DATABASE, OBSERVABILITY_DATABASE), KV, R2, all DOs
- D1 migrations applied automatically from `wrangler.toml` paths
- Seed helpers: `tests/workers/helpers/seed-d1.ts` has `seedUser`, `seedInstallation`, `seedProject`, `seedNode`, `seedTask`
- Pattern: import `env` from `cloudflare:test`, use `env.DATABASE.prepare()` for direct SQL

### Approach
Since the scheduled jobs call service functions that make external HTTP calls (Hetzner API, VM agent) and DO RPC calls, we need a hybrid approach:
1. **Real D1** via Miniflare for all database state
2. **vi.mock()** for external HTTP services (`deleteNodeResources`, `stopWorkspaceOnNode`, etc.) — but with realistic return values
3. **Real OBSERVABILITY_DATABASE** via Miniflare for observability writes
4. **Verify D1 state changes** after job runs (not just mock call counts)

## Implementation Checklist

- [ ] Extend `seed-d1.ts` with helpers for: `seedWorkspace`, `seedComputeUsage` (for use by new tests)
- [ ] Create `tests/workers/scheduled-node-cleanup.test.ts`:
  - [ ] Test stale warm node cleanup: seed warm node + no running workspaces → verify node status changes to 'deleted' in D1
  - [ ] Test stale warm node skipped when workspaces exist: seed warm node + running workspace → verify warm_since cleared
  - [ ] Test orphaned workspace stopping: seed workspace with completed task → verify workspace status changes to 'stopped'
  - [ ] Test stopped workspace deletion: seed stopped workspace past TTL → verify status changes to 'deleted'
  - [ ] Test orphaned node detection: seed running node with no workspaces → verify observability event recorded
  - [ ] Verify `deleteNodeResources` called with correct args (nodeId, userId, env)
  - [ ] Verify `persistError` called with structured context including recoveryType
- [ ] Create `tests/workers/scheduled-stuck-tasks.test.ts`:
  - [ ] Test stuck queued task detection: seed task with old updated_at → verify status changes to 'failed' in D1
  - [ ] Test optimistic locking: seed task, simulate status change between SELECT and UPDATE → verify graceful skip
  - [ ] Test heartbeat grace period: seed in_progress task with recent heartbeat → verify task skipped
  - [ ] Test diagnostic gathering: seed task with workspace and node → verify diagnostics contain workspace/node status
  - [ ] Verify `cleanupTaskRun` called for stuck tasks
  - [ ] Verify observability event recorded with structured diagnostics
- [ ] Create `tests/workers/scheduled-observability-purge.test.ts`:
  - [ ] Seed platform_errors with mixed ages → verify old errors purged
  - [ ] Seed > max rows → verify oldest excess rows purged
  - [ ] Verify no purge when OBSERVABILITY_DATABASE missing
- [ ] Create `tests/workers/scheduled-compute-usage-cleanup.test.ts`:
  - [ ] Seed compute_usage with open record + stopped workspace → verify ended_at set
  - [ ] Seed compute_usage with open record + running workspace → verify not closed
  - [ ] Seed compute_usage with open record + missing workspace → verify ended_at set
- [ ] Create `tests/workers/scheduled-analytics-forward.test.ts`:
  - [ ] Verify disabled by default (no ANALYTICS_FORWARD_ENABLED) → returns enabled: false
- [ ] All tests pass: `pnpm test:workers`

## Acceptance Criteria

- [ ] Node-cleanup vertical slice tests verify D1 state changes (not just mock calls)
- [ ] Stuck-tasks tests cover optimistic locking race condition
- [ ] Observability-purge has age-based and count-based purge tests
- [ ] Compute-usage-cleanup tests verify LEFT JOIN orphan detection
- [ ] Analytics-forward test verifies disabled-by-default behavior
- [ ] All tests run in Miniflare workers pool with real D1
- [ ] CI green

## References
- `.claude/rules/35-vertical-slice-testing.md`
- `apps/api/vitest.workers.config.ts`
- `apps/api/tests/workers/helpers/seed-d1.ts`
