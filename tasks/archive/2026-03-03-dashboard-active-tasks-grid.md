# Dashboard Active Tasks Grid

**Created**: 2026-03-03
**Status**: backlog

## Problem Statement

The main dashboard currently shows a grid of project cards with basic info (name, repo, workspace/session counts, last activity). Users need a task-centric view that shows which tasks are currently in progress, how long ago they were submitted, when the last message was received, whether the task is still active (no message in 15+ min = inactive), and easy navigation to the project chat session.

## Research Findings

### Current State
- **Dashboard** (`apps/web/src/pages/Dashboard.tsx`): Shows project cards in a 3-column grid using `useProjectList` hook
- **ProjectSummaryCard** (`apps/web/src/components/ProjectSummaryCard.tsx`): Shows status, name, repo, workspace/session counts, last activity
- **Data source**: `GET /api/projects` returns `ProjectSummary[]` with `taskCountsByStatus` (empty in list endpoint), `lastActivityAt`, etc.

### Task Data (D1)
- Tasks table: `id, projectId, userId, title, status, executionStep, startedAt, completedAt, createdAt, updatedAt`
- Active statuses: `queued`, `delegated`, `in_progress`
- Tasks have `workspaceId` linking to workspace

### Chat Session Data (ProjectData DO)
- Sessions stored in per-project Durable Object SQLite
- `chat_sessions` table has `updated_at` column updated on every message persist
- `mapSessionRow()` selects `updated_at` but does NOT include it in the output
- Sessions link to tasks via `task_id` column
- `listSessions()` supports filtering by `taskId`

### Key Files
- `packages/shared/src/types.ts` — shared type definitions
- `apps/api/src/routes/projects.ts` — project list API
- `apps/api/src/routes/tasks.ts` — task CRUD API
- `apps/api/src/durable-objects/project-data.ts` — DO with session/message storage
- `apps/api/src/services/project-data.ts` — service wrapper for DO calls
- `apps/web/src/pages/Dashboard.tsx` — dashboard page
- `apps/web/src/components/ProjectSummaryCard.tsx` — project card
- `apps/web/src/hooks/useProjectData.ts` — data fetching hooks
- `apps/web/src/lib/api.ts` — API client functions

## Implementation Checklist

### Backend

- [ ] Add `DashboardTask` and `DashboardResponse` types to `packages/shared/src/types.ts`
- [ ] Add `getSessionsByTaskIds(taskIds: string[])` RPC method to `ProjectData` DO
- [ ] Add `getSessionsByTaskIds` wrapper to `apps/api/src/services/project-data.ts`
- [ ] Expose `lastMessageAt` (from `updated_at`) in `mapSessionRow()` output
- [ ] Create `apps/api/src/routes/dashboard.ts` with `GET /active-tasks` endpoint
  - Query D1 for tasks in active states (`queued`, `delegated`, `in_progress`) for current user
  - Join with projects table for project name
  - Group by projectId, batch DO calls for session data per project
  - Merge, compute `isActive` (last message within 15 min), sort by `lastMessageAt` DESC
- [ ] Mount dashboard routes in API router

### Frontend

- [ ] Add `listActiveTasks()` API function to `apps/web/src/lib/api.ts`
- [ ] Create `useActiveTasks` hook in `apps/web/src/hooks/useActiveTasks.ts`
  - Poll every 15 seconds (active tasks change frequently)
- [ ] Create `ActiveTaskCard` component in `apps/web/src/components/ActiveTaskCard.tsx`
  - Shows: task title, project name, status badge with execution step
  - Shows: "Submitted X ago" (from `createdAt`)
  - Shows: "Last message X ago" or "No messages yet" (from `lastMessageAt`)
  - Shows: Active/Inactive indicator (green/gray dot, 15 min threshold)
  - Click navigates to `/projects/:projectId/chat/:sessionId`
- [ ] Update `Dashboard.tsx`:
  - Primary section: "Active Tasks" grid (ordered by most recent message)
  - Secondary section: "Projects" grid (existing cards)
  - Empty state for no active tasks

### Tests

- [ ] Unit test for `ActiveTaskCard` component (rendering, click navigation)
- [ ] Integration test for `GET /dashboard/active-tasks` endpoint
- [ ] Test `isActive` computation logic (15 min threshold)

## Acceptance Criteria

1. Dashboard shows active tasks as the primary grid view
2. Each task card shows title, project name, submission time, last message time, and active/inactive status
3. Tasks are ordered by most recent message received
4. "Inactive" indicator shown when no message received in 15+ minutes
5. Clicking a task card navigates to the project chat session for that task
6. Projects section still accessible below active tasks
7. Responsive grid layout (1 col mobile, 2 col tablet, 3 col desktop)
8. Polls for updates regularly (15s interval)

## References

- `.claude/rules/06-technical-patterns.md` — React component patterns
- `.claude/rules/03-constitution.md` — no hardcoded values (15 min threshold should be configurable)
- `docs/adr/004-hybrid-d1-do-storage.md` — hybrid storage pattern
