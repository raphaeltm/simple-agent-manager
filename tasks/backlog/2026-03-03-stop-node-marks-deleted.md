# Stop Node Should Mark as Deleted

## Problem

When a node is stopped via `POST /api/nodes/:id/stop`, it powers off the Hetzner server but the node and its workspaces remain in the database with status `'stopped'`. Since there's no restart endpoint for nodes, a stopped node is effectively dead — it can never be used again. The powered-off Hetzner server also wastes resources.

The database status should reflect reality: stopped nodes are deleted.

## Research Findings

### Key Files
- `apps/api/src/services/nodes.ts:178-247` — `stopNodeResources()` calls `powerOffServer()` instead of `deleteServer()`
- `apps/api/src/services/nodes.ts:249-296` — `deleteNodeResources()` already deletes server + DNS
- `apps/api/src/routes/nodes.ts:191-239` — Stop route handler
- `apps/api/src/routes/nodes.ts:241-289` — Delete route handler (hard deletes records)
- `apps/api/src/routes/nodes.ts:127-139` — List nodes (no status filtering)
- `apps/api/src/routes/workspaces.ts:337-363` — List workspaces (optional status filtering)
- `packages/shared/src/types.ts:579-590` — NodeStatus and WorkspaceStatus types
- `packages/ui/src/components/StatusBadge.tsx` — Status display component

### Current Behavior
1. `stopNodeResources()` calls `powerOffServer()` — just powers off, doesn't delete from Hetzner
2. Sets node status to `'stopped'`, workspaces to `'stopped'`
3. No `'deleted'` status exists in types
4. List endpoints return all statuses including stopped
5. DELETE endpoint hard-deletes records from D1

### Desired Behavior
1. `stopNodeResources()` should call `deleteServer()` + `deleteDNSRecord()` — actually free resources
2. Node and workspaces should be marked with status `'deleted'`
3. List endpoints should exclude `'deleted'` items by default
4. DELETE endpoint continues to hard-delete records

## Implementation Checklist

- [ ] Add `'deleted'` to `NodeStatus` union in `packages/shared/src/types.ts`
- [ ] Add `'deleted'` to `WorkspaceStatus` union in `packages/shared/src/types.ts`
- [ ] Update `stopNodeResources()` in `apps/api/src/services/nodes.ts`:
  - Call `deleteServer()` instead of `powerOffServer()`
  - Add DNS record deletion (like `deleteNodeResources()` does)
  - Set node status to `'deleted'` instead of `'stopped'`
  - Set workspace status to `'deleted'` instead of `'stopped'`
- [ ] Update GET `/api/nodes` to exclude `status = 'deleted'` by default
- [ ] Update GET `/api/workspaces` to exclude `status = 'deleted'` by default
- [ ] Add `'deleted'` entry to `StatusBadge` component config
- [ ] Add/update tests for stop node behavior
- [ ] Run full quality suite (lint, typecheck, test, build)

## Acceptance Criteria

- [ ] Stopping a node deletes the Hetzner server (not just powers it off)
- [ ] Stopping a node deletes the DNS record
- [ ] Stopped nodes have status `'deleted'` in D1
- [ ] Stopped workspaces on that node have status `'deleted'` in D1
- [ ] Deleted nodes don't appear in `GET /api/nodes` response
- [ ] Deleted workspaces don't appear in `GET /api/workspaces` response
- [ ] StatusBadge renders "Deleted" with appropriate styling
- [ ] DELETE endpoint still hard-deletes records (unchanged behavior)
- [ ] All tests pass, types check, lint passes
