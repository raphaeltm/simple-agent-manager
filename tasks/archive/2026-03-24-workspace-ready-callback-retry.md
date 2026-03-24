# Workspace Ready Callback Retry on Heartbeat Recovery

## Problem

Workspaces provision successfully on VMs but the control plane never learns about it because the `workspace-ready` callback fails due to transient network issues. The VM agent's callback retry window (5 attempts, ~2 minutes) exhausts before connectivity is restored. When heartbeats resume (proving the network is back), the callback is never re-sent.

**Consequences:**
- Task stuck in `delegated` status permanently (until 30-min timeout)
- Chat session stuck as `active` in the sidebar
- Workspace marked as `error` on VM side despite being fully functional
- User cannot even manually complete the task (`delegated → completed` is invalid)

## Root Cause

1. `bootstrap.PrepareWorkspace()` calls `markWorkspaceReady()` as its final step
2. If the callback fails, `PrepareWorkspace()` returns an error
3. `startWorkspaceProvision()` treats this as a **provisioning failure** — marks workspace as `error`
4. No mechanism exists to retry the callback when connectivity is restored

## Research Findings

### Key Files
- `packages/vm-agent/internal/bootstrap/bootstrap.go` — `PrepareWorkspace()` and `markWorkspaceReady()`
- `packages/vm-agent/internal/server/workspaces.go` — `startWorkspaceProvision()` error handling
- `packages/vm-agent/internal/server/health.go` — heartbeat loop
- `packages/vm-agent/internal/server/server.go` — `WorkspaceRuntime` struct
- `packages/vm-agent/internal/callbackretry/retry.go` — callback retry config
- `apps/api/src/durable-objects/task-runner.ts` — `handleWorkspaceReady()` step
- `packages/shared/src/constants.ts` — configurable defaults

### Current Flow
1. Workspace provisions successfully (clone, container, git config all complete)
2. `markWorkspaceReady()` callback fails after 5 retry attempts (~2 min)
3. `PrepareWorkspace()` returns error
4. `startWorkspaceProvision()` sets workspace status to `error` and tries to send `provisioning-failed` callback (which also fails)
5. TaskRunner DO waits at `workspace_ready` step for callback that never arrives
6. After 30-minute timeout, task finally fails

### Design Decision
The fix separates callback delivery failure from actual provisioning failure using a sentinel error type (`CallbackError`). When only the callback fails, the workspace is marked as running (not error) and the pending callback is tracked. The heartbeat loop retries the callback when connectivity is restored.

## Implementation Checklist

- [x] **bootstrap.go**: Add `CallbackError` sentinel type wrapping callback-only failures
- [x] **bootstrap.go**: `PrepareWorkspace()` returns `CallbackError` (not plain error) when `markWorkspaceReady()` fails
- [x] **server.go**: Add `ReadyCallbackPending` and `ReadyCallbackStatus` fields to `WorkspaceRuntime`
- [x] **server.go**: Add `markReadyCallbackPending()`, `pendingReadyCallbacks()`, `clearReadyCallbackPending()` helpers
- [x] **workspaces.go**: In `startWorkspaceProvision()`, detect `CallbackError` and transition workspace to running (not error), track pending callback
- [x] **health.go**: Add `retryPendingReadyCallbacks()` — called after successful heartbeat, retries pending callbacks
- [x] **health.go**: Wire retry into `sendNodeHeartbeat()` after successful response
- [x] **constants.ts**: Add `DEFAULT_TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS` (30s)
- [x] **task-runner.ts**: Add `TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS` env var and getter
- [x] **task-runner.ts**: Change `handleWorkspaceReady()` to poll D1 every 30s instead of single alarm at timeout boundary
- [x] **Tests**: Go tests for heartbeat callback retry (success, no-pending, permanent error)
- [x] **Tests**: Go test for `CallbackError` sentinel type
- [x] **Tests**: Update existing TypeScript tests that assert "no D1 polling" to reflect periodic polling

## Acceptance Criteria

- [x] When workspace-ready callback fails but workspace is functional, workspace status on VM is `running` (not `error`)
- [x] When heartbeat succeeds after callback failure, workspace-ready callback is retried
- [x] On successful retry, pending flag is cleared and control plane is notified
- [x] On permanent error (4xx), retry stops (workspace may have been deleted)
- [x] TaskRunner polls D1 every 30s during `workspace_ready` step (catches callback that updates D1 but fails DO notification)
- [x] All existing tests pass with updated assertions
- [x] New tests cover the retry mechanism

## References

- Logs from 2026-03-24 showing the failure pattern
- `packages/vm-agent/internal/callbackretry/retry.go` — existing retry infrastructure
- `.claude/rules/03-constitution.md` — Principle XI (configurable values)
