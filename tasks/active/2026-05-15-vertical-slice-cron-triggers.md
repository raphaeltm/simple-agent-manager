# Vertical Slice Tests: Cron Triggers & Trigger Execution Cleanup

## Problem
The cron trigger sweep (`cron-triggers.ts`) and trigger execution cleanup (`trigger-execution-cleanup.ts`) have shallow unit tests where core behavior is entirely mocked:
- `submitTriggeredTask()` is mocked — template rendering, cron parsing, and execution state transitions are untested through the real code path
- D1 `batch()` operations are mocked — recovery and purge SQL never runs against a real database

## Research Findings

### cron-triggers.ts (339 lines)
- Uses Drizzle ORM against D1 for trigger discovery, execution record management, and trigger metadata updates
- `submitTriggeredTask()` is the external boundary — it touches DOs, GitHub, AI, etc.
- Template rendering via `buildCronContext()` + `renderTemplate()` — pure functions, no external deps
- Cron parsing via `cronToNextFire()` — pure function, no external deps
- State transitions: execution queued → running (on success) or queued → failed (on submit error)
- Trigger metadata: lastTriggeredAt, triggerCount incremented on fire

### trigger-execution-cleanup.ts (316 lines)
- Uses raw D1 SQL (not Drizzle) — `db.prepare()`, `db.batch()`
- No external service boundaries — entirely D1 operations
- Can be tested fully end-to-end with real Miniflare D1
- Three sweeps: stale running recovery, stale queued recovery, retention purge

### Testing Approach
- Use Miniflare workers test pool (`vitest.workers.config.ts`) with real D1
- Seed D1 with realistic trigger, execution, task, user, project data
- For cron-triggers: mock only `submitTriggeredTask()` at the boundary; let template rendering, cron parsing, and D1 operations run through real code
- For cleanup: no mocking needed — test fully against real D1
- Add seed helpers for triggers and trigger_executions to `tests/workers/helpers/seed-d1.ts`

## Implementation Checklist

- [ ] Add `seedTrigger()` and `seedTriggerExecution()` helpers to `tests/workers/helpers/seed-d1.ts`
- [ ] Create `tests/workers/cron-trigger-sweep.test.ts` with vertical slice tests:
  - [ ] Trigger discovery: only active cron triggers with nextFireAt <= now
  - [ ] skipIfRunning: skip when running execution exists
  - [ ] maxConcurrent enforcement
  - [ ] Template rendering with realistic project/trigger data
  - [ ] Execution state: queued → running with linked taskId
  - [ ] Trigger metadata updates (lastTriggeredAt, triggerCount)
  - [ ] advanceNextFireAt with real cron expression parsing
  - [ ] Error handling: execution → failed when submit throws
  - [ ] Auto-pause after consecutive failures
- [ ] Create `tests/workers/trigger-execution-cleanup.test.ts` with vertical slice tests:
  - [ ] Stale running detection with real D1 timestamps
  - [ ] Recovery reason: task deleted / terminal / stuck / no-task
  - [ ] Batch UPDATE persists — SELECT after UPDATE to verify
  - [ ] Stale queued recovery
  - [ ] Retention purge by created_at cutoff
  - [ ] Kill switch (TRIGGER_EXECUTION_CLEANUP_ENABLED=false)
- [ ] All tests pass with `pnpm test:workers`

## Acceptance Criteria
- [ ] Vertical slice tests for cron sweep cover trigger discovery, template rendering, state transitions, and nextFireAt advancement through real D1
- [ ] Vertical slice tests for cleanup cover stale recovery and retention purge with real D1 batch operations
- [ ] No shallow mocks of D1 operations — only mock at the submitTriggeredTask boundary
- [ ] Tests follow patterns in existing workers tests (seed-d1.ts helpers, cloudflare:test env)
- [ ] CI green

## References
- `apps/api/src/scheduled/cron-triggers.ts`
- `apps/api/src/scheduled/trigger-execution-cleanup.ts`
- `apps/api/tests/workers/helpers/seed-d1.ts`
- `.claude/rules/35-vertical-slice-testing.md`
