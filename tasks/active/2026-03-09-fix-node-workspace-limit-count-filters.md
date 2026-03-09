# Fix Node/Workspace Limit Checks Counting Deleted Entities

## Problem

Node and workspace limit checks in two locations count **all** entities regardless of status, causing users to hit `MAX_NODES_PER_USER` and `MAX_WORKSPACES_PER_NODE` limits when they shouldn't be — deleted and stopped nodes/workspaces are counted toward the cap.

## Root Cause

Three count queries lack status filtering:

1. **`apps/api/src/routes/workspaces.ts:474-476`** — Drizzle `count()` on `nodes` table with only `userId` filter. Counts deleted/stopped nodes toward `MAX_NODES_PER_USER`.

2. **`apps/api/src/routes/workspaces.ts:507-509`** — Drizzle `count()` on `workspaces` table with only `userId` + `nodeId` filter. Counts deleted/stopped workspaces toward `MAX_WORKSPACES_PER_NODE`.

3. **`apps/api/src/durable-objects/task-runner.ts:418-420`** — Raw SQL `SELECT COUNT(*) FROM nodes WHERE user_id = ?`. No status filter. Counts all nodes toward `MAX_NODES_PER_USER`.

## Correct Reference Implementations

These locations already filter correctly:

- `apps/api/src/routes/nodes.ts:152-155` — `ne(schema.nodes.status, 'deleted')`
- `apps/api/src/durable-objects/task-runner.ts:1325` — `status IN ('running', 'creating', 'recovery')`
- `apps/api/src/services/node-selector.ts:222-228` — `inArray(status, ['running', 'creating', 'recovery'])`

## Implementation Checklist

- [ ] Fix `workspaces.ts:474` node count to exclude deleted/stopped nodes
- [ ] Fix `workspaces.ts:507` workspace count to exclude deleted/stopped workspaces
- [ ] Fix `task-runner.ts:419` raw SQL to exclude deleted/stopped nodes
- [ ] Add/update unit tests for each fix
- [ ] Run typecheck, lint, test

## Acceptance Criteria

- [ ] All three limit-check queries filter out non-active entities
- [ ] Users can create new nodes/workspaces when existing ones are deleted/stopped
- [ ] Existing correct queries are not regressed
- [ ] Tests verify the filtering behavior
