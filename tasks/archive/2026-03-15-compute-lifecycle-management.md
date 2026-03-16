# Compute Lifecycle Management

**Created**: 2026-03-15
**Status**: complete
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

- [x] `POST /api/workspaces` returns 400 if `projectId` is missing
- [x] `CreateWorkspaceRequest.projectId` is required (not optional) in shared types
- [x] CreateWorkspace UI page requires project selection
- [x] Terminal WebSocket proxy updates `lastTerminalActivity` in ProjectData DO (throttled to 1/min)
- [x] ProjectData DO runs periodic alarm checking workspace idle state
- [x] Idle workspaces (no messages AND no terminal activity for timeout period) are auto-deleted
- [x] Default workspace idle timeout: 2 hours, configurable per-project (range: 30min–24h)
- [ ] Default node idle timeout: 30 min, configurable per-project (range: 5min–4h) — **Deferred**: `nodeIdleTimeoutMs` stored in D1 and exposed in UI but not yet consumed by NodeLifecycle DO. See `tasks/backlog/2026-03-16-wire-node-idle-timeout-to-lifecycle-do.md`.
- [x] 12-hour absolute ceiling removed; nodes with active workspaces never force-killed
- [x] Project settings UI shows workspace and node idle timeout configuration
- [ ] Tests cover: projectId enforcement, terminal activity tracking, idle timeout alarm, node cleanup simplification — **Partial**: idle timeout alarm test blocked by pre-existing @mastra/core workers test infrastructure issue on main

## Implementation Checklist

### Phase 1: Require Project Binding
- [x] Make `projectId` required in `CreateWorkspaceRequest` (packages/shared/src/types.ts)
- [x] Add API validation in workspace creation (apps/api/src/routes/workspaces/crud.ts) — reject if no projectId
- [x] Update CreateWorkspace UI page to require project selection
- [x] Verify task runner path already complies (verified — task-runner.ts passes state.projectId at insert time)
- [x] Update tests for projectId enforcement

### Phase 2: Terminal Activity Tracking
- [x] Add `workspace_activity` table to ProjectData DO SQLite (new migration 010)
- [x] Add `updateTerminalActivity(workspaceId)` method to ProjectData DO
- [x] Add service layer function for terminal activity updates
- [x] Update terminal token endpoint to report terminal activity via waitUntil
- [x] Add `POST /api/terminal/activity` endpoint for frontend heartbeats

### Phase 3: Workspace Idle Timeout
- [x] Add `workspace_idle_timeout_ms` column to projects table (D1 migration 0029)
- [x] Add default constants to packages/shared/src/constants.ts
- [x] Add `checkWorkspaceIdleTimeouts()` method to ProjectData DO
- [x] Integrate with DO alarm system (extend recalculateAlarm)
- [x] Workspace deletion via existing delete flow when idle timeout exceeded
- [x] Record activity event on idle cleanup

### Phase 4: Simplify Node Cleanup
- [x] Add `node_idle_timeout_ms` column to projects table (D1 migration 0029, same as Phase 3)
- [x] Remove absolute ceiling logic from node-cleanup.ts cron sweep
- [x] Keep warm pool (Layer 1) and cron sweep (Layer 2)
- [x] Ensure nodes with active workspaces are never force-killed
- [ ] Make node warm timeout respect per-project settings — **Deferred**: `nodeIdleTimeoutMs` stored but NodeLifecycle DO does not read per-project settings. See `tasks/backlog/2026-03-16-wire-node-idle-timeout-to-lifecycle-do.md`.

### Phase 5: Project Settings UI
- [x] Add `UpdateProjectRequest` fields for timeout settings
- [x] Add API validation for timeout ranges
- [x] Add timeout settings to ProjectSettings page
- [ ] Add timeout settings to SettingsDrawer component — **Deferred**: timeout settings only on full ProjectSettings page; SettingsDrawer deferred to follow-up.

## Key Files

- `packages/shared/src/types.ts` — CreateWorkspaceRequest, UpdateProjectRequest
- `packages/shared/src/constants.ts` — default timeout constants
- `apps/api/src/routes/workspaces/crud.ts` — workspace creation validation
- `apps/api/src/routes/terminal.ts` — terminal activity endpoint
- `apps/api/src/durable-objects/project-data.ts` — DO idle alarm
- `apps/api/src/durable-objects/migrations.ts` — DO SQLite migrations
- `apps/api/src/scheduled/node-cleanup.ts` — cron sweep simplification
- `apps/api/src/db/schema.ts` — project settings columns
- `apps/api/src/routes/projects/crud.ts` — project settings API
- `apps/web/src/pages/ProjectSettings.tsx` — settings UI

## Design Decisions

- **API-level enforcement only** for projectId (no DB NOT NULL migration needed)
- **Terminal activity throttled to 1/min** to avoid write amplification on every keystroke
- **Workspace idle = no messages AND no terminal activity** — both signals must be stale
- **Per-project timeouts stored in D1 projects table** — ProjectData DO reads them when checking
- **Node cleanup simplified** — remove absolute ceiling entirely, trust workspace-level idle detection
- **nodeIdleTimeoutMs deferred** — stored for future use; NodeLifecycle DO needs cross-DO D1 lookup to read per-project settings, which adds complexity beyond this task's scope
