# Compute Lifecycle Management

**Created**: 2026-03-15
**Status**: backlog
**Priority**: high

## Problem

Workspaces can be created without a project link, making them invisible to the control plane for lifecycle management. There's no idle detection for workspaces (terminal-only usage is invisible), and the node cleanup has an arbitrary 12-hour absolute ceiling that force-kills nodes with active workspaces.

## Solution

1. Require project binding on all workspaces (API-level enforcement)
2. Track terminal activity via the WebSocket proxy → ProjectData DO
3. Workspace idle timeout via ProjectData DO alarm using max(lastMessage, lastTerminalActivity)
4. Simplify node cleanup: remove absolute ceiling, keep warm pool + cron sweep
5. Make timeouts configurable per-project in settings

## Acceptance Criteria

- [ ] `POST /api/workspaces` returns 400 if `projectId` is missing
- [ ] `CreateWorkspaceRequest.projectId` is required (not optional) in shared types
- [ ] CreateWorkspace UI page requires project selection
- [ ] Terminal WebSocket proxy updates `lastTerminalActivity` in ProjectData DO (throttled to 1/min)
- [ ] ProjectData DO runs periodic alarm checking workspace idle state
- [ ] Idle workspaces (no messages AND no terminal activity for timeout period) are auto-deleted
- [ ] Default workspace idle timeout: 2 hours, configurable per-project (range: 30min–24h)
- [ ] Default node idle timeout: 30 min, configurable per-project (range: 5min–4h)
- [ ] 12-hour absolute ceiling removed; nodes with active workspaces never force-killed
- [ ] Project settings UI shows workspace and node idle timeout configuration
- [ ] Tests cover: projectId enforcement, terminal activity tracking, idle timeout alarm, node cleanup simplification

## Implementation Checklist

### Phase 1: Require Project Binding
- [ ] Make `projectId` required in `CreateWorkspaceRequest` (packages/shared/src/types.ts)
- [ ] Add API validation in workspace creation (apps/api/src/routes/workspaces/crud.ts) — reject if no projectId
- [ ] Update CreateWorkspace UI page to require project selection
- [ ] Verify task runner path already complies (it does)
- [ ] Update tests for projectId enforcement

### Phase 2: Terminal Activity Tracking
- [ ] Add `lastTerminalActivity` column to ProjectData DO SQLite (new migration)
- [ ] Add `updateTerminalActivity(workspaceId)` method to ProjectData DO
- [ ] Add service layer function for terminal activity updates
- [ ] Update terminal WebSocket proxy (apps/api/src/routes/workspaces/runtime.ts) to report terminal activity (throttled 1/min)
- [ ] Add API endpoint for terminal activity updates

### Phase 3: Workspace Idle Timeout
- [ ] Add `workspace_idle_timeout_ms` column to projects table (D1 migration)
- [ ] Add default constants to packages/shared/src/constants.ts
- [ ] Add `checkWorkspaceIdleTimeouts()` method to ProjectData DO
- [ ] Integrate with DO alarm system (extend recalculateAlarm)
- [ ] Workspace deletion via existing delete flow when idle timeout exceeded
- [ ] Record activity event on idle cleanup

### Phase 4: Simplify Node Cleanup
- [ ] Add `node_idle_timeout_ms` column to projects table (D1 migration, same as Phase 3)
- [ ] Remove absolute ceiling logic from node-cleanup.ts cron sweep
- [ ] Keep warm pool (Layer 1) and cron sweep (Layer 2)
- [ ] Ensure nodes with active workspaces are never force-killed
- [ ] Make node warm timeout respect per-project settings

### Phase 5: Project Settings UI
- [ ] Add `UpdateProjectRequest` fields for timeout settings
- [ ] Add API validation for timeout ranges
- [ ] Add timeout settings to ProjectSettings page
- [ ] Add timeout settings to SettingsDrawer component

## Key Files

- `packages/shared/src/types.ts` — CreateWorkspaceRequest, UpdateProjectRequest
- `packages/shared/src/constants.ts` — default timeout constants
- `apps/api/src/routes/workspaces/crud.ts` — workspace creation validation
- `apps/api/src/routes/workspaces/runtime.ts` — terminal WebSocket proxy
- `apps/api/src/durable-objects/project-data.ts` — DO idle alarm
- `apps/api/src/durable-objects/migrations.ts` — DO SQLite migrations
- `apps/api/src/scheduled/node-cleanup.ts` — cron sweep simplification
- `apps/api/src/durable-objects/node-lifecycle.ts` — warm pool DO
- `apps/api/src/db/schema.ts` — project settings columns
- `apps/api/src/routes/projects/crud.ts` — project settings API
- `apps/web/src/pages/ProjectSettings.tsx` — settings UI
- `apps/web/src/components/project/SettingsDrawer.tsx` — settings drawer

## Design Decisions

- **API-level enforcement only** for projectId (no DB NOT NULL migration needed)
- **Terminal activity throttled to 1/min** to avoid write amplification on every keystroke
- **Workspace idle = no messages AND no terminal activity** — both signals must be stale
- **Per-project timeouts stored in D1 projects table** — ProjectData DO reads them when checking
- **Node cleanup simplified** — remove absolute ceiling entirely, trust workspace-level idle detection
