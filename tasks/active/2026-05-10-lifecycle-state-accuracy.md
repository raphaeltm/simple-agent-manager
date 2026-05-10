# Lifecycle State Accuracy Fixes

## Problem

Multiple entity types (nodes, ACP sessions, chat sessions) can get stuck in incorrect states indefinitely, leading to inaccurate usage tracking and stale data in the UI. The existing cleanup systems have gaps:

1. **Orphaned nodes** are detected by the cron sweep but only logged — never destroyed
2. **ACP sessions** that never received a heartbeat (`last_heartbeat_at IS NULL`) are invisible to the heartbeat timeout sweep
3. **Chat sessions** have no staleness sweep at all — they stay `active` forever if the workspace stop doesn't propagate
4. **Node heartbeat staleness** doesn't drive status transitions — a node with no heartbeat for days stays "running" in D1
5. **User quota/limits** aren't surfaced on the usage page — users can't see their effective limits

## Research Findings

### Existing cleanup systems
- **Node cleanup cron** (`apps/api/src/scheduled/node-cleanup.ts`): 5-minute sweep handles stale warm nodes, max-lifetime auto-provisioned nodes, orphaned workspaces, orphaned node detection (flag-only), and stopped workspace TTL deletion
- **Stuck task recovery** (`apps/api/src/scheduled/stuck-tasks.ts`): catches stuck queued/delegated/in_progress tasks with configurable timeouts and heartbeat-aware grace periods
- **ACP session heartbeat** (`apps/api/src/durable-objects/project-data/acp-sessions.ts`): DO alarm-driven, checks `WHERE status IN ('assigned','running') AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at < cutoff`
- **Idle cleanup** (`apps/api/src/durable-objects/project-data/idle-cleanup.ts`): per-session idle timeout in ProjectData DO
- **NodeLifecycle DO** (`apps/api/src/durable-objects/node-lifecycle.ts`): warm pool state machine with alarm-driven destruction

### Staging evidence
- Node `01KPJMMVWB70BA7MEGA7Z5GAS8`: status=running, warm_since=NULL, last_heartbeat=2026-05-01, no active workspaces. Should have been destroyed weeks ago.
- The orphan detection (step 4) logs this node every 5 minutes but never acts on it.

### Budget/quota UI
- `UserAiBudgetResponse` already returns `effectiveLimits` (dailyInputTokenLimit, dailyOutputTokenLimit), `isCustom`, `settings.monthlyCostCapUsd`
- `BudgetSettingsSection` shows utilization bars but doesn't show the effective limits as standalone info — only in the context of the utilization bar denominator
- No credential source info in the budget response; credential source is on the workspace runtime response

### Constants location
- `packages/shared/src/constants/node-pooling.ts` for node cleanup defaults
- `packages/shared/src/constants/index.ts` for ACP session defaults (ACP_SESSION_DEFAULTS)

## Implementation Checklist

### Fix 1: Orphaned nodes — destroy instead of flag
- [ ] In `node-cleanup.ts` step 4, change orphaned node handling from flag-only to `deleteNodeResources()` + D1 status update to `deleted`
- [ ] Add `DEFAULT_ORPHANED_NODE_DESTROY_GRACE_PERIOD_MS` constant (default 1 hour) to `packages/shared/src/constants/node-pooling.ts`
- [ ] Use env var `ORPHANED_NODE_DESTROY_GRACE_PERIOD_MS` (separate from `ORPHANED_WORKSPACE_GRACE_PERIOD_MS`)
- [ ] Record cleanup in OBSERVABILITY_DATABASE like other destroy paths
- [ ] Rename result field from `orphanedNodesFlagged` to `orphanedNodesDestroyed`
- [ ] Add unit test verifying orphaned nodes are destroyed

### Fix 2: ACP sessions with NULL heartbeat
- [ ] Add `checkNoHeartbeatTimeouts()` function in `acp-sessions.ts` that catches sessions in `assigned`/`running` with `last_heartbeat_at IS NULL` AND `created_at < cutoff`
- [ ] Add `DEFAULT_ACP_SESSION_NO_HEARTBEAT_TIMEOUT_MS` constant (default 30 minutes) to `packages/shared/src/constants/index.ts`
- [ ] Call from ProjectData DO `alarm()` handler alongside existing `checkHeartbeatTimeouts()`
- [ ] Include in `computeHeartbeatAlarmTime()` calculation so the alarm fires for these sessions too
- [ ] Add unit test

### Fix 3: Chat session staleness sweep
- [ ] Add `checkStaleChatSessions()` function in `sessions.ts` that:
  - Stops `active` chat sessions whose workspace is `stopped`/`deleted`/`error` (query D1 for workspace status)
  - Stops `active` chat sessions with no workspace_id that have been active past a configurable threshold
- [ ] Add `DEFAULT_CHAT_SESSION_STALE_TIMEOUT_MS` constant (default 2 hours) to shared constants
- [ ] Call from ProjectData DO `alarm()` handler
- [ ] Include in alarm time calculation
- [ ] Add unit test

### Fix 4: Node heartbeat staleness → destroy
- [ ] Add step 6 in `node-cleanup.ts` that finds running nodes with `last_heartbeat_at` older than threshold AND no active workspaces
- [ ] Add `DEFAULT_NODE_HEARTBEAT_STALE_DESTROY_MS` constant (default 1 hour) to `packages/shared/src/constants/node-pooling.ts`
- [ ] Use env var `NODE_HEARTBEAT_STALE_DESTROY_MS`
- [ ] Call `deleteNodeResources()` and update D1 status
- [ ] Add `heartbeatStaleDestroyed` to `NodeCleanupResult`
- [ ] Add unit test

### Fix 5: Quota display on usage page
- [ ] Add a "Your Limits" card above or alongside the utilization bars in `BudgetSettingsSection` showing:
  - Daily input token limit (with "Platform default" or "Custom" label)
  - Daily output token limit (with "Platform default" or "Custom" label)
  - Monthly cost cap (or "Unlimited" if null)
- [ ] Data already available from `budget.effectiveLimits` and `budget.isCustom` — no API changes needed

## Acceptance Criteria

- [ ] Orphaned nodes with no workspaces and no heartbeat for >1h are destroyed by the cron sweep (not just flagged)
- [ ] ACP sessions that never received a heartbeat are transitioned to `interrupted` after 30 minutes
- [ ] Chat sessions whose workspace is in a terminal state are stopped by the DO alarm
- [ ] Running nodes with stale heartbeats and no active workspaces are destroyed
- [ ] Users can see their effective quota/limits on the Settings > Usage page
- [ ] All new cleanup behaviors have unit tests
- [ ] All new constants are configurable via env vars with sensible defaults
- [ ] Existing cleanup behavior is not regressed

## References

- `apps/api/src/scheduled/node-cleanup.ts` — node/workspace cleanup cron
- `apps/api/src/scheduled/stuck-tasks.ts` — stuck task recovery
- `apps/api/src/durable-objects/project-data/acp-sessions.ts` — ACP session lifecycle
- `apps/api/src/durable-objects/project-data/sessions.ts` — chat session lifecycle
- `apps/api/src/durable-objects/project-data/index.ts` — DO alarm handler
- `apps/api/src/durable-objects/project-data/idle-cleanup.ts` — idle cleanup
- `apps/web/src/pages/SettingsComputeUsage.tsx` — usage/budget UI
- `packages/shared/src/constants/node-pooling.ts` — node cleanup constants
- `packages/shared/src/types/ai-usage.ts` — budget response types
