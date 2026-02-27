# Tasks: TDF-2 Orchestration Engine

**Input**: `specs/tdf-2-orchestration-engine/` (spec.md, plan.md, data-model.md)

## Phase 1: Shared Infrastructure

- [ ] T001 Add TaskRunner DO defaults to `packages/shared/src/types.ts` (env var defaults for retry, timeout, backoff)
- [ ] T002 Add `TASK_RUNNER` DO binding to `apps/api/wrangler.toml` (all environments) with migration tag `v4`
- [ ] T003 Add `TASK_RUNNER` to `Env` interface in `apps/api/src/index.ts`
- [ ] T004 Export `TaskRunner` class from `apps/api/src/index.ts`

## Phase 2: TaskRunner DO Core

- [ ] T005 Create `apps/api/src/durable-objects/task-runner.ts` — TaskRunner DO class with state schema, alarm dispatch, and step handlers
- [ ] T006 Create `apps/api/src/services/task-runner-do.ts` — helper functions to start/advance/query the TaskRunner DO from worker context
- [ ] T007 [P] Unit tests for each step handler in `apps/api/tests/unit/durable-objects/task-runner.test.ts`
- [ ] T008 [P] Unit tests for DO helper service in `apps/api/tests/unit/services/task-runner-do.test.ts`

## Phase 3: User Story 1 — Durable Task Execution (P1)

### Step Handlers

- [ ] T009 Implement `handleNodeSelection` — query D1 for nodes, try warm pool, select or trigger provisioning
- [ ] T010 Implement `handleNodeProvisioning` — create node record, call Hetzner API, poll for running status
- [ ] T011 Implement `handleNodeAgentReady` — poll VM agent health endpoint with alarm-based retry
- [ ] T012 Implement `handleWorkspaceCreation` — create workspace in D1, POST to VM agent, transition task to delegated
- [ ] T013 Implement `handleWorkspaceReady` — check for received callback or wait via alarm timeout
- [ ] T014 Implement `handleAgentSession` — create agent session in D1, POST to VM agent, transition task to in_progress
- [ ] T015 Implement error handling and retry logic — transient vs permanent failure detection, exponential backoff
- [ ] T016 Implement cleanup on failure — stop workspace, mark node warm if auto-provisioned

## Phase 4: User Story 2 — Callback-Driven Advancement (P1)

- [ ] T017 Add `advanceWorkspaceReady()` RPC method to TaskRunner DO
- [ ] T018 Modify `/workspaces/{id}/ready` route to look up task and poke TaskRunner DO
- [ ] T019 Handle early callback arrival (before DO reaches workspace_ready step)
- [ ] T020 Handle provisioning-failed callback from VM agent (workspace error)
- [ ] T021 Integration test: callback arrives → DO advances without polling

## Phase 5: Route Migration (P1)

- [ ] T022 Modify `apps/api/src/routes/task-submit.ts` — wake TaskRunner DO instead of `waitUntil(executeTaskRun())`
- [ ] T023 Modify `apps/api/src/routes/task-runs.ts` — wake TaskRunner DO instead of `waitUntil(executeTaskRun())`
- [ ] T024 Update `apps/api/src/services/task-runner.ts` — keep `cleanupTaskRun()`, remove/deprecate `executeTaskRun()` and `initiateTaskRun()`

## Phase 6: User Story 3 — Observability (P2)

- [ ] T025 Add structured logging to each step handler (step name, duration, task context)
- [ ] T026 Write failures to OBSERVABILITY_DATABASE on permanent failure
- [ ] T027 Update stuck-tasks cron to skip or use longer timeouts for DO-managed tasks

## Phase 7: User Story 4 — Migration Safety (P2)

- [ ] T028 Ensure in-flight tasks under old system still complete via stuck-task cron
- [ ] T029 Add a `doManaged` marker to tasks table or task record so cron knows the task has a DO

## Phase 8: Integration & E2E Tests

- [ ] T030 Integration test: full pipeline with mocked external services (Hetzner API, VM agent)
- [ ] T031 Integration test: alarm-driven step progression through all steps
- [ ] T032 Integration test: DO restart recovery (state persists across alarm cycles)
- [ ] T033 Integration test: concurrent alarm + callback handling
- [ ] T034 Integration test: failure at each step → correct error state + cleanup
- [ ] T035 Integration test: timeout at each step → stuck detection → failure
- [ ] T036 E2E test: task submit → DO orchestration → mocked VM → completion

## Phase 9: Polish & Documentation

- [ ] T037 Update `docs/guides/self-hosting.md` with new TASK_RUNNER DO binding
- [ ] T038 Update `CLAUDE.md` with TaskRunner DO in key concepts
- [ ] T039 Code cleanup — remove dead code paths from old waitUntil approach
- [ ] T040 Run full test suite, fix any regressions

## Dependencies & Execution Order

- **Phase 1** (T001-T004): No dependencies — shared setup
- **Phase 2** (T005-T008): Depends on Phase 1
- **Phase 3** (T009-T016): Depends on Phase 2 (T005 DO class must exist)
- **Phase 4** (T017-T021): Depends on Phase 3 (step handlers must exist)
- **Phase 5** (T022-T024): Depends on Phase 2 (DO helper must exist)
- **Phase 6** (T025-T027): Depends on Phase 3
- **Phase 7** (T028-T029): Depends on Phase 5
- **Phase 8** (T030-T036): Depends on all implementation phases
- **Phase 9** (T037-T040): Depends on Phase 8
