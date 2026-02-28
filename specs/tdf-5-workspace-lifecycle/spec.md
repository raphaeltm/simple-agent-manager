# Feature Specification: TDF-5 Workspace Lifecycle -- Event-Driven Readiness

**Feature Branch**: `tdf-5/workspace-lifecycle-events`
**Created**: 2026-02-28
**Status**: Draft
**Dependencies**: TDF-2 (Orchestration Engine), TDF-4 (VM Agent Contract)
**Input**: TDF-5 task definition + TDF-2 orchestration engine + flow map analysis

## Summary

Remove the D1 polling fallback from the TaskRunner DO's `handleWorkspaceReady()` step and make the workspace-ready callback the sole mechanism for advancing the task pipeline. With TDF-4's retry-enabled callbacks on the VM agent side, the D1 polling loop is redundant and introduces unnecessary latency, complexity, and a residual `waitUntil()` death window. This change makes the callback notification inline (not `waitUntil()`) and ensures comprehensive test coverage for all workspace lifecycle race conditions.

## Problem Statement

### Current Implementation (Hybrid Callback + Polling)

The `handleWorkspaceReady()` step in the TaskRunner DO currently uses a hybrid approach:

1. **Primary path (callback-driven)**: The VM agent calls `POST /workspaces/{id}/ready`, which updates D1 and calls `advanceTaskRunnerWorkspaceReady()` to wake the DO via `waitUntil()`.
2. **Fallback path (D1 polling)**: The DO's alarm handler polls D1 every `TASK_RUNNER_AGENT_POLL_INTERVAL_MS` (default 5s) to check if the workspace status has changed to `running`.

### Why the Fallback Is Now Unnecessary

TDF-4 added retry logic with exponential backoff to the VM agent's `markWorkspaceReady()` and `notifyProvisioningFailed()` calls. The callback path is now reliable:

- The VM agent retries the `/ready` callback with exponential backoff (up to 10 attempts)
- The callback handler in `workspaces.ts` updates D1 and notifies the DO
- The DO stores the signal and advances immediately

The D1 polling fallback introduces three problems:

1. **Complexity**: The `handleWorkspaceReady()` handler has two advancement paths, making reasoning about state transitions harder.
2. **Latency**: Even though the callback fires immediately, the D1 poll adds up to 5s latency if the callback's `waitUntil()` notification was lost.
3. **waitUntil() death window**: The callback handler uses `c.executionCtx.waitUntil()` to notify the DO. If the Worker is recycled between the D1 update and the DO notification, the callback signal is lost and the DO must wait for its next poll alarm to detect the change via D1.

### Target Architecture (Pure Callback-Driven)

```
VM Agent                    API Worker                  TaskRunner DO
   |                            |                            |
   |-- POST /ready ----------->|                            |
   |                            |-- UPDATE D1 (running)     |
   |                            |-- advanceWorkspaceReady() -->|
   |                            |   (inline, not waitUntil)  |
   |                            |                            |-- check state
   |                            |                            |   if at workspace_ready:
   |                            |                            |     advance to agent_session
   |                            |                            |   else:
   |                            |                            |     store for later
   |                            |<-- 200 OK                  |
   |<-- 200 OK                 |                            |
```

The key changes:
- **Remove D1 polling** from `handleWorkspaceReady()` -- the callback is the only advancement mechanism
- **Make DO notification inline** -- move from `waitUntil()` to synchronous `await` in the callback handler
- **Keep the timeout alarm** -- if the callback never arrives (VM crashed, all retries exhausted), the DO's timeout alarm still fires and fails the task

## User Scenarios & Testing

### User Story 1 -- Callback-Driven Workspace Readiness (Priority: P1)

A task is at the `workspace_ready` step. The VM agent finishes provisioning and calls `POST /workspaces/{id}/ready`. The callback handler updates D1 and wakes the TaskRunner DO inline. The DO immediately advances to `agent_session` without any polling delay.

**Acceptance Scenarios**:

1. **Given** a task at `workspace_ready` step, **When** the ready callback arrives, **Then** the DO advances to `agent_session` within the same request (no polling delay).
2. **Given** a task at `workspace_creation` step (before workspace_ready), **When** the ready callback arrives early, **Then** the callback is stored in DO state and processed when the DO reaches `workspace_ready`.
3. **Given** a task at `workspace_ready` step, **When** the callback does NOT arrive within `TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS`, **Then** the DO alarm fires and fails the task with a timeout error.
4. **Given** a task already failed or completed, **When** a late callback arrives, **Then** it is a no-op (idempotent).
5. **Given** duplicate callbacks (VM agent retries), **When** both arrive, **Then** only the first is processed; the second is a no-op.

### User Story 2 -- Provisioning Failure Callback (Priority: P1)

The VM agent encounters a provisioning error and calls `POST /workspaces/{id}/provisioning-failed`. The callback handler updates D1 and wakes the TaskRunner DO. The DO fails the task and triggers cleanup.

**Acceptance Scenarios**:

1. **Given** a task at `workspace_ready` step, **When** the provisioning-failed callback arrives, **Then** the DO transitions to error state and triggers cleanup.
2. **Given** a task at an earlier step, **When** the provisioning-failed callback arrives early, **Then** the error is stored and processed when the DO reaches `workspace_ready`.
3. **Given** a task already in a terminal state, **When** the provisioning-failed callback arrives, **Then** it is a no-op.

### User Story 3 -- Timeout Safety Net (Priority: P2)

If the VM crashes and all callback retries are exhausted, the TaskRunner DO's timeout alarm is the safety net. The timeout fires and fails the task with a descriptive error.

**Acceptance Scenarios**:

1. **Given** a task at `workspace_ready` step and no callback arrives, **When** the timeout elapses, **Then** the DO fails the task with error "Workspace did not become ready within {timeout}ms".
2. **Given** a task at `workspace_ready` step, **When** the DO alarm fires before the callback, **Then** the DO re-schedules a timeout alarm (not a D1 poll).

### Edge Cases

- **Callback arrives during DO alarm execution**: Durable Objects guarantee single-threaded execution. The callback RPC will be queued and executed after the alarm handler completes.
- **D1 update succeeds but DO notification fails**: The inline `await` ensures both happen in the same request. If the DO notification fails, the entire callback request returns an error, and the VM agent retries.
- **Workspace stopped externally during provisioning**: The DO's timeout alarm fires, checks workspace status, and fails the task.

## Requirements

### Functional Requirements

- **FR-001**: `handleWorkspaceReady()` MUST NOT poll D1 for workspace status. Advancement MUST be driven solely by the `advanceWorkspaceReady()` callback.
- **FR-002**: The `/workspaces/{id}/ready` route MUST call `advanceTaskRunnerWorkspaceReady()` inline (not via `waitUntil()`).
- **FR-003**: The `/workspaces/{id}/provisioning-failed` route MUST call `advanceTaskRunnerWorkspaceReady()` with status `'error'` inline.
- **FR-004**: `handleWorkspaceReady()` MUST still schedule a timeout alarm when no callback has been received.
- **FR-005**: The timeout alarm in `handleWorkspaceReady()` MUST only check the callback-received flag and timeout -- not D1.
- **FR-006**: `advanceWorkspaceReady()` MUST be idempotent -- duplicate calls with the same status are no-ops after the first.
- **FR-007**: If the DO has already completed or the task is in a terminal state, `advanceWorkspaceReady()` MUST return without error.

### Non-Functional Requirements

- **NFR-001**: The callback-to-advancement latency MUST be under 100ms (no polling delay).
- **NFR-002**: All changes MUST have comprehensive test coverage (unit + integration).
- **NFR-003**: All timeouts MUST remain configurable via environment variables (Constitution Principle XI).

## Detailed Changes

### 1. `apps/api/src/durable-objects/task-runner.ts` -- `handleWorkspaceReady()`

**Remove**: The D1 polling fallback block that checks workspace status in D1 and the `setAlarm()` for polling interval.

**Keep**: The callback-received flag check, timeout detection, and timeout alarm scheduling.

**Before** (current hybrid):
```typescript
private async handleWorkspaceReady(state: TaskRunnerState): Promise<void> {
  // ... timeout tracking init ...
  
  // Check callback flag
  if (state.workspaceReadyReceived) { /* advance */ }
  
  // Check timeout
  if (elapsed > timeoutMs) { /* fail */ }
  
  // D1 fallback poll  <-- REMOVE THIS
  if (state.stepResults.workspaceId) {
    const ws = await this.env.DATABASE.prepare(...)
    if (ws.status === 'running') { /* advance */ }
  }
  
  // Schedule next poll alarm  <-- CHANGE THIS
  await this.ctx.storage.setAlarm(Date.now() + this.getAgentPollIntervalMs());
}
```

**After** (pure callback):
```typescript
private async handleWorkspaceReady(state: TaskRunnerState): Promise<void> {
  // ... timeout tracking init ...
  
  // Check callback flag
  if (state.workspaceReadyReceived) { /* advance or fail based on status */ }
  
  // Check timeout
  if (elapsed > timeoutMs) { /* fail */ }
  
  // No callback yet, not timed out -- schedule timeout alarm
  const remaining = timeoutMs - elapsed;
  await this.ctx.storage.setAlarm(Date.now() + remaining);
}
```

### 2. `apps/api/src/routes/workspaces.ts` -- `/ready` and `/provisioning-failed` handlers

**Change**: Move the `advanceTaskRunnerWorkspaceReady()` call from `waitUntil()` to inline `await`. This ensures the DO notification happens before the response is sent to the VM agent. If the DO notification fails, the request returns an error, and the VM agent will retry.

**Before** (waitUntil):
```typescript
c.executionCtx.waitUntil(
  (async () => {
    const [task] = await db.select(...)...;
    if (task) {
      await advanceTaskRunnerWorkspaceReady(c.env, task.id, readyStatus, null);
    }
  })().catch(() => { /* best-effort */ })
);
```

**After** (inline):
```typescript
// Notify TaskRunner DO inline (not waitUntil)
const [task] = await db
  .select({ id: schema.tasks.id, status: schema.tasks.status })
  .from(schema.tasks)
  .where(
    and(
      eq(schema.tasks.workspaceId, workspaceId),
      inArray(schema.tasks.status, ['queued', 'delegated'])
    )
  )
  .limit(1);

if (task) {
  await advanceTaskRunnerWorkspaceReady(c.env, task.id, readyStatus, null);
}
```

### 3. Test Coverage

See `tasks.md` for the complete test matrix. Key test categories:

- **Callback happy path**: callback arrives -> DO advances to agent_session
- **Early callback**: callback before DO reaches workspace_ready -> stored, processed later
- **Late callback**: callback after timeout -> no-op
- **Duplicate callback**: second callback is idempotent no-op
- **Provisioning failure**: error callback -> DO fails task + cleanup
- **Timeout**: no callback arrives -> DO alarm fires -> task fails
- **Inline notification**: DO notification failure -> request error -> VM agent retries

## Out of Scope

- **VM agent changes**: TDF-4 already added retry logic. No VM-side changes needed.
- **TaskRunner DO step machine**: No new steps or step transitions. Only the `handleWorkspaceReady()` implementation changes.
- **Workspace creation flow**: No changes to `handleWorkspaceCreation()`.
- **Stuck-task cron**: No changes needed -- it already serves as a safety net.
- **Frontend changes**: No UI impact -- the task lifecycle is the same from the frontend's perspective.
