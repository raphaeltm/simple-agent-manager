# Prevent Duplicate Workspace Creation on Node-Ready Callback

## Problem

When TaskRunner creates a workspace and calls `createWorkspaceOnVmAgent()`, the VM agent's node-ready callback (`POST /nodes/:id/ready`) can race and dispatch the same workspace a second time. The node-ready handler queries D1 for all workspaces with `status = 'creating'` on that node and dispatches each one — including workspaces that TaskRunner already dispatched.

This causes duplicate `devcontainer up` processes, competing buildx commands, git credential helper collisions, and containerd manifest lock contention.

## Research Findings

### Key Code Paths

1. **TaskRunner dispatch**: `apps/api/src/durable-objects/task-runner/workspace-steps.ts:createAndProvisionWorkspace()` creates a workspace row with `status = 'creating'` and then calls `createWorkspaceOnVmAgent()` (line 167).

2. **Node-ready handler**: `apps/api/src/routes/node-lifecycle.ts:57` (`POST /:id/ready`) queries `SELECT ... FROM workspaces WHERE node_id = :nodeId AND status = 'creating'` and dispatches each one via `createWorkspaceOnNode()`.

3. **VM agent endpoint**: `POST /workspaces` in `packages/vm-agent/internal/server/workspaces.go:354` upserts the workspace runtime and always calls `startWorkspaceProvision()` which spawns a goroutine — no idempotency guard.

### Race Window

The race window is between:
- TaskRunner inserts workspace row with `status = 'creating'` (line 138-156)
- TaskRunner calls `createWorkspaceOnVmAgent()` (line 167)
- Node sends ready callback, handler queries `status = 'creating'` workspaces

Since the workspace row is inserted before the VM agent call, the node-ready handler finds it in `creating` state and dispatches it again.

### Safety Net Purpose

The node-ready handler's workspace dispatch is a legitimate safety net: if TaskRunner crashes between creating the workspace row and sending the request to the VM agent, the node-ready handler recovers the workspace. This safety net must be preserved.

### Solution: Dispatch Marker Column

Add a `dispatched_to_agent_at` column to the workspaces table. Set it immediately before calling `createWorkspaceOnVmAgent()`. The node-ready handler skips workspaces where `dispatched_to_agent_at IS NOT NULL`.

This preserves the safety net: workspaces created but not yet dispatched (TaskRunner crashed) will still have `dispatched_to_agent_at = NULL` and will be picked up by the ready handler.

## Implementation Checklist

- [ ] Add D1 migration `0049_workspace_dispatched_marker.sql`: `ALTER TABLE workspaces ADD COLUMN dispatched_to_agent_at TEXT;`
- [ ] Add `dispatchedToAgentAt` column to Drizzle schema in `apps/api/src/db/schema.ts`
- [ ] Set `dispatched_to_agent_at` in `createAndProvisionWorkspace()` before calling `createWorkspaceOnVmAgent()`
- [ ] Filter out dispatched workspaces in node-ready handler (`dispatched_to_agent_at IS NULL`)
- [ ] Add integration test: TaskRunner dispatch + node-ready overlap → only one VM agent request
- [ ] Add integration test: workspace created but not dispatched → node-ready handler dispatches it (safety net preserved)
- [ ] Run typecheck, lint, test

## Acceptance Criteria

- [ ] When TaskRunner dispatches a workspace, a subsequent node-ready callback does NOT re-dispatch it
- [ ] When TaskRunner creates a workspace row but crashes before dispatching, the node-ready callback DOES dispatch it
- [ ] The `dispatched_to_agent_at` column is nullable (null = not yet dispatched)
- [ ] Existing workspace creation flows (manual, trial orchestrator) are unaffected
- [ ] Tests cover both the race prevention and the safety-net recovery path

## References

- `apps/api/src/durable-objects/task-runner/workspace-steps.ts` — TaskRunner workspace creation
- `apps/api/src/routes/node-lifecycle.ts` — Node-ready handler
- `apps/api/src/services/node-agent.ts` — `createWorkspaceOnNode()` helper
- `packages/vm-agent/internal/server/workspaces.go` — VM agent `handleCreateWorkspace`
- `.claude/rules/31-migration-safety.md` — Migration safety rules
