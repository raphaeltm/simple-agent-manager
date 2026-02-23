# Fix Workspace-Project Association on Project Page

**Created**: 2026-02-23
**Priority**: Medium
**Classification**: `ui-change`, `cross-component-change`

## Context

Workspaces attached to a repository show up associated with the correct project on the Dashboard, but NOT on the actual project page (ProjectOverview). The Dashboard fetches all workspaces and groups them client-side by `projectId`. The ProjectOverview only shows a count (`Linked workspaces: N`) but never fetches or displays the actual workspace cards.

## Root Cause Analysis

### Dashboard (works correctly):
- `apps/web/src/pages/Dashboard.tsx:37-48` — calls `listWorkspaces()` to fetch ALL workspaces
- `Dashboard.tsx:113-127` — groups workspaces by `projectId` client-side using `useMemo`
- Renders `WorkspaceCard` components for each grouped workspace

### ProjectOverview (broken):
- `apps/web/src/pages/ProjectOverview.tsx:1-186` — gets `project` from `ProjectContext`
- Only displays `project.summary.linkedWorkspaces` as a **count** (line 160)
- **Never fetches** actual workspace objects for the project
- No `WorkspaceCard` rendering at all

### API gaps:
- `GET /api/workspaces` (`workspaces.ts:334-356`) — supports `?status` and `?nodeId` filters but **NOT `?projectId`**
- `GET /api/projects/:id` (`projects.ts:409-472`) — returns only workspace **counts**, not actual workspace data
- `api.ts:623-631` — `listWorkspaces()` client function also missing `projectId` parameter

## Plan

1. Add `?projectId` filter support to `GET /api/workspaces` endpoint
2. Add `projectId` parameter to `listWorkspaces()` client function
3. Fetch and display workspace cards on ProjectOverview page

## Detailed Tasklist

- [ ] Add `projectId` query parameter support to `GET /api/workspaces` in `apps/api/src/routes/workspaces.ts`
- [ ] Update `listWorkspaces()` in `apps/web/src/lib/api.ts` to accept `projectId` parameter
- [ ] Add workspace fetching to `apps/web/src/pages/ProjectOverview.tsx` using `listWorkspaces({ projectId })`
- [ ] Render workspace cards on ProjectOverview (reuse existing `WorkspaceCard` component from Dashboard)
- [ ] Show loading state only when no data yet (follow the new loading state pattern)
- [ ] Handle empty state (no workspaces for this project)
- [ ] Run typecheck: `pnpm typecheck`
- [ ] Run build: `pnpm build`

## Files to Modify

| File | Change |
|------|--------|
| `apps/api/src/routes/workspaces.ts` | Add `projectId` query filter to GET / |
| `apps/web/src/lib/api.ts` | Add `projectId` param to `listWorkspaces()` |
| `apps/web/src/pages/ProjectOverview.tsx` | Fetch and display workspace cards |
