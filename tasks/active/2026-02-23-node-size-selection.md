# Add Node Size Selection to Workspace Creation

**Created**: 2026-02-23
**Priority**: High
**Classification**: `ui-change`, `business-logic-change`

## Context

Users cannot select a node/VM size when creating workspaces. The "Launch Workspace" button on ProjectOverview creates workspaces with no size parameter. The CreateWorkspace page has size selection UI but only when creating a new node (hidden when using existing node). The Nodes page also lacks size selection.

## Current State

### Backend (fully supports sizes):
- `packages/shared/src/types.ts:654` — `VMSize = 'small' | 'medium' | 'large'`
- `packages/shared/src/constants.ts:5-9` — Size configs: small (cx23/2CPU/4GB), medium (cx33/4CPU/8GB), large (cx43/8CPU/16GB)
- `apps/api/src/routes/workspaces.ts:306` — Defaults to `'medium'` if not provided
- Database schema stores `vmSize` on both nodes and workspaces tables

### Frontend (incomplete):
- `apps/web/src/pages/CreateWorkspace.tsx:114-117` — `VM_SIZES` array defined with 3 options
- `CreateWorkspace.tsx:141-160` — Size selector UI exists but **only shows when `!selectedNodeId`** (creating new node)
- `apps/web/src/pages/ProjectOverview.tsx:41-50` — Quick launch calls `createWorkspace()` with **no vmSize parameter**
- `apps/web/src/lib/api.ts:623-631` — `listWorkspaces()` API client supports size params

## Plan

1. Add a default VM size setting to project settings
2. Use project default size when quick-launching from ProjectOverview
3. Ensure CreateWorkspace page always shows size selection (even with existing nodes — for the workspace record)
4. Add size selection to node creation on the Nodes page

## Detailed Tasklist

- [ ] Add `defaultVmSize` field to project settings schema in `apps/api/src/db/schema.ts`
- [ ] Create migration for the new column
- [ ] Update project PATCH endpoint in `apps/api/src/routes/projects.ts` to accept `defaultVmSize`
- [ ] Update project settings UI (`apps/web/src/pages/ProjectSettings.tsx`) to include VM size selector
- [ ] Update `ProjectOverview.tsx` quick launch to use project's `defaultVmSize` (or show a quick size picker)
- [ ] Ensure `CreateWorkspace.tsx` shows size selection regardless of whether an existing node is selected
- [ ] Add size selection to node creation on the Nodes page
- [ ] Update shared types if needed for project settings
- [ ] Run typecheck: `pnpm typecheck`
- [ ] Run build: `pnpm build`
- [ ] Test the complete flow: project settings -> default size -> quick launch

## Files to Modify

| File | Change |
|------|--------|
| `apps/api/src/db/schema.ts` | Add `defaultVmSize` to projects table |
| `apps/api/src/routes/projects.ts` | Accept `defaultVmSize` in PATCH |
| `apps/web/src/pages/ProjectSettings.tsx` | Add VM size selector |
| `apps/web/src/pages/ProjectOverview.tsx` | Use project default size in quick launch |
| `apps/web/src/pages/CreateWorkspace.tsx` | Always show size selection |
| `packages/shared/src/types.ts` | Update project types if needed |
