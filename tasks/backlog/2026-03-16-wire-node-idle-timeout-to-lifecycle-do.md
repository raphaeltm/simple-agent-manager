# Wire Per-Project Node Idle Timeout to NodeLifecycle DO

**Created**: 2026-03-16
**Status**: backlog
**Priority**: medium

## Problem

The `nodeIdleTimeoutMs` project setting is stored in D1 and exposed in the ProjectSettings UI, but the `NodeLifecycle` DO that controls how long nodes stay in the warm pool does not read this per-project value. Nodes always use the global `NODE_WARM_TIMEOUT_MS` env var regardless of project settings.

## Context

Added as part of the compute lifecycle management task (2026-03-15). The column and UI were implemented, but wiring it into `NodeLifecycle` DO requires:
1. Determining which project a node belongs to (via workspace → project lookup in D1)
2. Querying D1 from within the NodeLifecycle DO for per-project timeout
3. Handling the case where a node has workspaces from multiple projects

## Acceptance Criteria

- [ ] NodeLifecycle DO reads `node_idle_timeout_ms` from the project associated with the node's workspaces
- [ ] Per-project value overrides global `NODE_WARM_TIMEOUT_MS` when set
- [ ] Nodes with workspaces from multiple projects use the longest timeout
- [ ] Test verifies per-project node timeout is respected

## Key Files

- `apps/api/src/durable-objects/node-lifecycle.ts` — warm pool DO (needs D1 query)
- `apps/api/src/db/schema.ts` — `nodeIdleTimeoutMs` column (already exists)
- `apps/web/src/pages/ProjectSettings.tsx` — UI slider (already exists)
