# Protect Long-Running Workspaces from Premature Shutdown

**Created**: 2026-03-13
**Priority**: High
**Context**: Tasks can legitimately run for several hours (large test suites, complex refactors, multi-file migrations). The current lifecycle mechanisms have gaps that can kill active workspaces before their work is done.

## Problem

Three independent shutdown mechanisms can terminate a workspace or its underlying node while an agent task is still actively running:

### Risk 1: Max Node Lifetime Kills Active Workspaces (Critical)

The Layer 3 cron sweep (`apps/api/src/scheduled/node-cleanup.ts:145-198`) enforces `MAX_AUTO_NODE_LIFETIME_MS` (default **4 hours**) on auto-provisioned nodes. **It destroys nodes without checking whether they have active workspaces.** A task that has been running for 4+ hours will have its node destroyed out from under it.

**Code path**: `node-cleanup.ts:174` — comment says "Node exceeds max lifetime — destroy regardless" and proceeds to call `deleteNodeResources()` with no workspace status check.

**Contrast**: Layer 1 (stale warm nodes, line 66-143) correctly checks `running_ws_count` before destroying. Layer 3 does not.

### Risk 2: Stuck Task Recovery Fails Long Tasks (Medium)

The stuck task cron (`apps/api/src/scheduled/stuck-tasks.ts`) marks `in_progress` tasks as `failed` after `DEFAULT_TASK_RUN_MAX_EXECUTION_MS` (default **4 hours**, `packages/shared/src/constants.ts:142`). This is measured from `task.updatedAt`, which is set by `setExecutionStep()` — the last update happens when the task enters `running` state.

For a 5-hour task, this means the task gets failed at hour 4 even though the agent is actively working. The stuck task recovery does NOT check VM agent heartbeats or ACP session status.

### Risk 3: Timeout Alignment (Low but Confusing)

The max node lifetime (4h) and max task execution (4h) are the same value, creating a race condition where both mechanisms try to clean up simultaneously. The node might be destroyed before the task is marked failed, or vice versa, leading to inconsistent state.

## Current Protections (Working Correctly)

These mechanisms already have adequate active-workspace checks:

| Mechanism | Protection | Status |
|-----------|-----------|--------|
| **Warm pool timeout** (30 min) | `cleanupAutoProvisionedNode()` checks for active workspaces before marking node idle | OK |
| **Layer 1 cron sweep** (stale warm nodes) | Queries `running_ws_count`, only destroys if 0 | OK |
| **Idle cleanup** (15 min after agent completion) | Only fires after `agentCompletedAt` is set — won't fire while agent is still running | OK |
| **NodeLifecycle DO alarm** | Transitions to `destroying` only from `warm` state, not `active` | OK |

## Proposed Solution: Activity-Aware Lifecycle

### Phase 1: Fix the Critical Gap (Layer 3 Active Workspace Check)

Add an active workspace check to the max lifetime enforcement in `node-cleanup.ts`, matching what Layer 1 already does:

```typescript
// Before destroying for max lifetime, check for active workspaces
const activeWsCount = await db
  .select({ count: count() })
  .from(schema.workspaces)
  .where(
    and(
      eq(schema.workspaces.nodeId, node.id),
      inArray(schema.workspaces.status, ['running', 'creating', 'recovery'])
    )
  );

if (activeWsCount[0].count > 0) {
  log.warn('node_cleanup.max_lifetime_skipped_active_workspaces', {
    nodeId: node.id,
    activeWorkspaces: activeWsCount[0].count,
    createdAt: node.createdAt,
  });
  continue; // Skip — node has active workspaces
}
```

**Files to change**:
- `apps/api/src/scheduled/node-cleanup.ts` — add workspace check before Layer 3 destruction

### Phase 2: Heartbeat-Aware Stuck Task Recovery

Before the stuck task cron marks a long-running task as failed, check whether the VM agent is still alive and has active workspaces:

1. Look up the task's workspace and node
2. Check `node.lastHeartbeatAt` — if heartbeat is recent (within stale threshold), the agent is still running
3. If agent is active, skip the stuck task recovery and log it
4. Only fail the task if the heartbeat is stale (agent is actually dead)

**Files to change**:
- `apps/api/src/scheduled/stuck-tasks.ts` — add heartbeat check before failing `in_progress` tasks

### Phase 3: Configurable Extended Lifetime (Optional)

Allow users to set a longer max execution time when submitting a task, or at the project level:

- Add optional `maxExecutionTimeMs` to the task submit payload
- Store in `tasks` table
- Stuck task recovery uses per-task value if set, falls back to global default
- Max lifetime cron uses the longest active task's timeout on a node as a floor

**Files to change**:
- `apps/api/src/routes/tasks/run.ts` — accept `maxExecutionTimeMs`
- `apps/api/src/db/schema.ts` — add column
- `apps/api/src/scheduled/stuck-tasks.ts` — use per-task timeout
- `apps/api/src/scheduled/node-cleanup.ts` — query max active task timeout for node

### Phase 4: Hard Safety Ceiling

Even with activity checks, there must be an absolute maximum to prevent runaway costs:

- Introduce `ABSOLUTE_MAX_NODE_LIFETIME_MS` (default **12 hours**) — destroys nodes regardless of activity
- Log a loud warning when this ceiling is hit
- Configurable via env var

**Files to change**:
- `packages/shared/src/constants.ts` — add `DEFAULT_ABSOLUTE_MAX_NODE_LIFETIME_MS`
- `apps/api/src/scheduled/node-cleanup.ts` — add absolute ceiling check (runs after activity check)
- `apps/api/src/index.ts` — add env var to `Env` interface

## Acceptance Criteria

- [ ] Layer 3 max lifetime cron checks for active workspaces before destroying a node
- [ ] Stuck task recovery checks VM agent heartbeat before failing long-running tasks
- [ ] A task running for 5 hours on an auto-provisioned node is NOT killed (with defaults adjusted)
- [ ] An actually-stuck task (no heartbeat, agent dead) IS still cleaned up
- [ ] An absolute hard ceiling exists to prevent unbounded node lifetime
- [ ] All new behavior is configurable via env vars with sensible defaults
- [ ] Unit tests cover: active workspace skip, heartbeat-aware recovery, hard ceiling enforcement
- [ ] Integration test: simulate a long-running task with active heartbeat, verify it survives past old timeout

## Key Files

| File | Role |
|------|------|
| `apps/api/src/scheduled/node-cleanup.ts` | Cron sweep — Layer 3 max lifetime enforcement |
| `apps/api/src/scheduled/stuck-tasks.ts` | Stuck task recovery — fails long-running tasks |
| `packages/shared/src/constants.ts` | Default timeout values |
| `apps/api/src/durable-objects/node-lifecycle.ts` | Node state machine (already correct) |
| `apps/api/src/durable-objects/project-data.ts` | Idle cleanup scheduling (already correct) |
| `apps/api/src/services/task-runner.ts` | `cleanupAutoProvisionedNode()` (already correct) |
| `apps/api/src/index.ts` | `Env` interface for new env vars |

## Notes

- Phase 1 is a straightforward bug fix — Layer 3 should have always checked active workspaces like Layer 1 does
- Phase 2 leverages existing heartbeat infrastructure — no new VM agent changes needed
- Phase 3 is optional UX improvement — only needed if users regularly run tasks >4 hours
- Phase 4 is a safety net — keeps the "prevent unbounded cost" guarantee that Layer 3 was designed for
