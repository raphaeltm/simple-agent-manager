# Vertical Slice Tests for DO Proxy Services

## Problem

Three DO proxy services (`task-runner-do.ts`, `node-lifecycle.ts`, `project-orchestrator.ts`) have ZERO tests. These are the contract layers between Worker routes and their respective Durable Objects — if any call is malformed, it fails silently at runtime.

## Research Findings

- Existing pattern: `tests/workers/node-lifecycle-do.test.ts` tests the NodeLifecycle DO directly using Miniflare's `cloudflare:test` module
- `vitest.workers.config.ts` already has `TASK_RUNNER`, `NODE_LIFECYCLE` bindings configured; `PROJECT_ORCHESTRATOR` is missing and needs to be added
- The proxy services are thin wrappers that resolve DO stubs via `env.BINDING.idFromName(id)` and forward RPC calls
- `task-runner-do.ts` has 3 functions: `startTaskRunnerDO`, `advanceTaskRunnerWorkspaceReady`, `getTaskRunnerStatus` (no cancel exists despite task description)
- `node-lifecycle.ts` has 4 functions: `markIdle`, `markActive`, `tryClaim`, `getStatus`
- `project-orchestrator.ts` has 7 functions: `startOrchestration`, `pauseMission`, `resumeMission`, `cancelMission`, `overrideTaskState`, `notifyTaskEvent`, `getOrchestratorStatus`, `getSchedulingQueue`
- Seed helpers exist in `tests/workers/helpers/seed-d1.ts`
- ProjectOrchestrator uses embedded SQLite (needs `useSQLite: true` in config)
- ProjectOrchestrator reads/writes D1 `missions` and `tasks` tables — need seed helpers for those

## Implementation Checklist

- [x] Add `PROJECT_ORCHESTRATOR` binding to `vitest.workers.config.ts`
- [x] Add `seedMission` helper to `seed-d1.ts`
- [x] Create `tests/workers/task-runner-do-proxy.test.ts`
  - [x] `startTaskRunnerDO` — verify full config payload reaches DO
  - [x] `advanceTaskRunnerWorkspaceReady` — running, recovery, error paths
  - [x] `getTaskRunnerStatus` — status queries
- [x] Create `tests/workers/node-lifecycle-proxy.test.ts`
  - [x] `markIdle` — state transition + warm timeout
  - [x] `markActive` — clear warm state
  - [x] `tryClaim` — claim flow + defense-in-depth
  - [x] `getStatus` — status queries
- [x] Create `tests/workers/project-orchestrator-proxy.test.ts`
  - [x] `startOrchestration` — mission lifecycle start
  - [x] `pauseMission` / `resumeMission` — state transitions
  - [x] `cancelMission` — cancel with D1 verification
  - [x] `notifyTaskEvent` — event forwarding
  - [x] `getOrchestratorStatus` — status queries
- [x] All tests pass locally

## Acceptance Criteria

- [ ] All three proxy services have test coverage
- [ ] Tests verify both return values AND state changes in the DO/D1
- [ ] Tests include error paths (invalid state transitions)
- [ ] Tests run green in CI via `pnpm test:workers`

## References

- `apps/api/src/services/task-runner-do.ts`
- `apps/api/src/services/node-lifecycle.ts`
- `apps/api/src/services/project-orchestrator.ts`
- `apps/api/tests/workers/node-lifecycle-do.test.ts` (pattern)
- `.claude/rules/35-vertical-slice-testing.md`
