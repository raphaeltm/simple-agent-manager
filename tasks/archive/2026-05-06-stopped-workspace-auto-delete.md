# Auto-Delete Stopped Workspaces After TTL

## Problem

Stopped workspaces accumulate on nodes indefinitely, consuming disk space (Docker volumes with git repos, node_modules, build artifacts — often several GB per workspace). Eventually the node runs out of disk, preventing new workspace creation. There is no automatic cleanup mechanism for stopped workspaces.

## Solution

When a workspace transitions to `stopped`, schedule automatic deletion after a configurable TTL (default 5 minutes). Use the NodeLifecycle Durable Object's alarm infrastructure — it already manages per-node lifecycle and has D1/env access for cleanup.

## Research Findings

### Current Stop Flow
- `apps/api/src/routes/workspaces/lifecycle.ts:32-107` — user stop route
- `apps/api/src/services/task-runner.ts:47-118` — `cleanupTaskRun()` stops workspace after task completion
- `apps/api/src/durable-objects/task-runner/state-machine.ts:310-353` — `cleanupOnFailure()` stops workspace on task failure
- `apps/api/src/durable-objects/project-data/idle-cleanup.ts:87-191` — idle timeout stops workspace

### Current Delete Flow
- `apps/api/src/routes/workspaces/crud.ts:386-429` — user-initiated delete
- `apps/api/src/services/node-agent.ts:233-244` — `deleteWorkspaceOnNode()` calls VM agent DELETE endpoint
- VM agent: `docker rm -f` + `docker volume rm`

### NodeLifecycle DO
- `apps/api/src/durable-objects/node-lifecycle.ts` — already manages per-node alarms
- Has `DATABASE` binding, can query/update D1
- Keyed by `nodeId` via `env.NODE_LIFECYCLE.idFromName(nodeId)`

### Key Insight
The NodeLifecycle DO is per-node, but workspace deletions need to track multiple workspaces. I'll extend it to maintain a list of pending workspace deletions in its storage, and use the alarm to process them when they expire.

### Constants Location
- `packages/shared/src/constants/node-pooling.ts` — existing warm pool constants

## Implementation Checklist

- [ ] Add `DEFAULT_WORKSPACE_STOPPED_TTL_MS` constant (300000 = 5 min) to `packages/shared/src/constants/node-pooling.ts`
- [ ] Export from `packages/shared/src/constants/index.ts`
- [ ] Add `WORKSPACE_STOPPED_TTL_MS` to `NodeLifecycleEnv` type in `node-lifecycle.ts`
- [ ] Add `scheduleWorkspaceDeletion(workspaceId: string, nodeId: string, userId: string)` method to NodeLifecycle DO
  - Stores `{ workspaceId, userId, deleteAt: now + TTL }` in DO storage under `ws-delete:<workspaceId>`
  - Recalculates alarm to fire at the earliest pending deletion time
- [ ] Add `cancelWorkspaceDeletion(workspaceId: string)` method to NodeLifecycle DO
  - Removes the pending deletion entry (used when workspace is restarted before TTL expires)
  - Recalculates alarm
- [ ] Extend `alarm()` handler to process expired workspace deletions:
  - Find all entries with `deleteAt <= now`
  - For each: call `deleteWorkspaceOnNode()` equivalent (HTTP to VM agent), update D1 status to 'deleted', clean up agent_sessions
  - Remove processed entries from DO storage
  - Reschedule alarm for next pending item (or warm timeout, whichever is earlier)
- [ ] Call `scheduleWorkspaceDeletion()` from the workspace stop route (`lifecycle.ts`) after setting status to 'stopped'
- [ ] Call `scheduleWorkspaceDeletion()` from `cleanupTaskRun()` after stopping workspace
- [ ] Call `scheduleWorkspaceDeletion()` from `cleanupOnFailure()` after stopping workspace
- [ ] Call `scheduleWorkspaceDeletion()` from idle cleanup (`processExpiredCleanups`) after stopping workspace
- [ ] Call `cancelWorkspaceDeletion()` from the restart route (`lifecycle.ts`) before restarting
- [ ] Add `WORKSPACE_STOPPED_TTL_MS` to env.ts Env type
- [ ] Add to `apps/api/.env.example`
- [ ] Add unit tests for `scheduleWorkspaceDeletion`, `cancelWorkspaceDeletion`, and alarm-based deletion
- [ ] Add integration test: workspace stopped → alarm fires → workspace deleted
- [ ] Add integration test: workspace stopped → restarted before TTL → deletion cancelled
- [ ] Update CLAUDE.md "Recent Changes" section

## Acceptance Criteria

- [ ] Stopped workspaces are automatically deleted after 5 minutes (default)
- [ ] TTL is configurable via `WORKSPACE_STOPPED_TTL_MS` environment variable
- [ ] Restarting a workspace before TTL expires cancels the scheduled deletion
- [ ] Multiple workspaces can be pending deletion on the same node simultaneously
- [ ] Alarm correctly handles both warm timeout and workspace deletion scheduling
- [ ] If VM agent is unreachable during deletion, the system retries on next alarm
- [ ] No data loss — D1 workspace record is updated to 'deleted' status (not hard-deleted)
- [ ] Existing tests continue to pass

## References

- `.claude/rules/03-constitution.md` — Principle XI: no hardcoded values
- `packages/shared/src/constants/node-pooling.ts` — existing node lifecycle constants
- `apps/api/src/durable-objects/node-lifecycle.ts` — DO to extend
