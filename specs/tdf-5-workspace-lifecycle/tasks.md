# Tasks: TDF-5 Workspace Lifecycle -- Event-Driven Readiness

**Input**: `specs/tdf-5-workspace-lifecycle/` (spec.md, plan.md, data-model.md)

## Phase 1: Remove D1 Polling from TaskRunner DO

- [ ] T001 Remove D1 polling fallback from `handleWorkspaceReady()` in `apps/api/src/durable-objects/task-runner.ts`
- [ ] T002 Change the fallback alarm from poll interval to timeout-based alarm scheduling

## Phase 2: Make Callback Notification Inline

- [ ] T003 Move `advanceTaskRunnerWorkspaceReady()` from `waitUntil()` to inline `await` in the `/workspaces/{id}/ready` handler
- [ ] T004 Move `advanceTaskRunnerWorkspaceReady()` from `waitUntil()` to inline `await` in the `/workspaces/{id}/provisioning-failed` handler

## Phase 3: Comprehensive Tests

- [ ] T005 Test: `handleWorkspaceReady()` advances immediately when callback flag is set (running status)
- [ ] T006 Test: `handleWorkspaceReady()` advances immediately when callback flag is set (recovery status)
- [ ] T007 Test: `handleWorkspaceReady()` throws permanent error when callback reports error status
- [ ] T008 Test: `handleWorkspaceReady()` times out when no callback arrives
- [ ] T009 Test: `handleWorkspaceReady()` schedules timeout alarm (not poll) when waiting
- [ ] T010 Test: `handleWorkspaceReady()` does NOT query D1 for workspace status
- [ ] T011 Test: `advanceWorkspaceReady()` stores signal when DO not yet at workspace_ready step
- [ ] T012 Test: `advanceWorkspaceReady()` fires immediate alarm when DO at workspace_ready step
- [ ] T013 Test: `advanceWorkspaceReady()` is no-op when DO is completed
- [ ] T014 Test: `advanceWorkspaceReady()` is no-op when DO state is null
- [ ] T015 Test: Duplicate `advanceWorkspaceReady()` calls are idempotent
- [ ] T016 Test: `/ready` route calls DO notification inline (source contract)
- [ ] T017 Test: `/provisioning-failed` route calls DO notification inline (source contract)
- [ ] T018 Test: `/ready` route does not use `waitUntil()` for DO notification (source contract)
- [ ] T019 Test: `/provisioning-failed` route does not use `waitUntil()` for DO notification (source contract)

## Dependencies & Execution Order

- **Phase 1** (T001-T002): No dependencies -- core DO change
- **Phase 2** (T003-T004): No dependencies on Phase 1 -- route-level change
- **Phase 3** (T005-T019): Depends on Phase 1 and Phase 2 (tests validate the new behavior)
