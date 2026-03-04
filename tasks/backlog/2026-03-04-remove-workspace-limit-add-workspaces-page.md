# Remove Per-User Workspace Limit & Add Workspaces Management Page

## Problem

1. **Per-user workspace limit blocks creation unnecessarily**: The API enforces `DEFAULT_MAX_WORKSPACES_PER_USER = 10` at `apps/api/src/routes/workspaces.ts:451-457`. This count includes ALL workspaces regardless of status (stopped, error, etc.), so users get "Maximum 10 workspaces allowed" even with zero running workspaces. Workspaces should only be capped by node capacity (already enforced via `maxWorkspacesPerNode`).

2. **No workspace management page**: Users cannot see or manage all their workspaces across nodes. Workspaces are only visible within individual node detail pages. Users need a central place to list, filter, and delete workspaces.

## Research Findings

### Key Files
- `packages/shared/src/constants.ts:55` — `DEFAULT_MAX_WORKSPACES_PER_USER = 10`
- `apps/api/src/routes/workspaces.ts:451-457` — Per-user limit enforcement (counts ALL statuses)
- `apps/api/src/services/limits.ts:71` — `maxWorkspacesPerUser` runtime config
- `apps/api/src/services/node-selector.ts:84-86` — Per-node capacity check (this one stays)
- `apps/web/src/components/NavSidebar.tsx` — Nav items (no Workspaces entry)
- `apps/web/src/App.tsx` — Router (no `/workspaces` list route)
- `apps/web/src/lib/api.ts` — `listWorkspaces()` API function already exists
- `apps/web/src/components/WorkspaceCard.tsx` — Reusable workspace card component

### Patterns
- `apps/web/src/pages/Nodes.tsx` — Reference for listing page structure
- `apps/web/src/pages/Projects.tsx` — Reference for page layout pattern

## Implementation Checklist

- [ ] Remove `maxWorkspacesPerUser` enforcement from workspace creation endpoint
- [ ] Remove `DEFAULT_MAX_WORKSPACES_PER_USER` constant and `MAX_WORKSPACES_PER_USER` env var
- [ ] Remove `maxWorkspacesPerUser` from limits service
- [ ] Create `apps/web/src/pages/Workspaces.tsx` listing page with:
  - List all user workspaces across all nodes
  - Status filter (running, stopped, error, all)
  - Delete action per workspace
  - Stop/restart actions
  - Link to parent node
  - Empty state
- [ ] Add "Workspaces" nav item in `NavSidebar.tsx` (after Nodes)
- [ ] Add `/workspaces` route in `App.tsx`
- [ ] Add tests for the removal of per-user limit
- [ ] Add tests for the Workspaces page component
- [ ] Run full quality suite: lint, typecheck, test, build

## Acceptance Criteria

- [ ] Users can create workspaces without hitting a per-user count limit
- [ ] Per-node workspace limits remain enforced
- [ ] Users can navigate to a Workspaces page from the sidebar
- [ ] Workspaces page lists all workspaces across all nodes
- [ ] Users can delete workspaces from the listing page
- [ ] All quality checks pass (lint, typecheck, test, build)
