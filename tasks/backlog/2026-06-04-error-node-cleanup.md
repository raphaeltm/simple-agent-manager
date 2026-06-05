# Failed-Provisioning Node Cleanup

## Problem

Nodes that fail provisioning (e.g., capacity exhaustion 422) remain in `status='error'` indefinitely. The cleanup sweep (`apps/api/src/scheduled/node-cleanup.ts`) only scans `status='running'` nodes for staleness. Error-state nodes must be manually deleted, wasting ~30 min per incident.

## Research Findings

- `node-cleanup.ts` queries nodes with `status='running'` and checks for missing heartbeats
- Nodes that fail during `provisionNode()` in `apps/api/src/services/nodes.ts` are set to `status='error'`
- These error nodes never enter the cleanup sweep's purview
- 47 occurrences of the capacity 422 over ~1 month, each leaving a dead node

## Implementation Checklist

- [ ] Extend node cleanup sweep to also scan `status='error'` nodes
- [ ] Auto-reap error nodes that have been in error state for > configurable threshold (default: 30 min)
- [ ] Ensure the reaper attempts to delete the VM from the provider (if it was partially created)
- [ ] Add tests for error-node cleanup path

## Acceptance Criteria

- [ ] Nodes in `status='error'` are automatically cleaned up after a configurable timeout
- [ ] Provider-side cleanup is attempted (idempotent delete)
- [ ] Existing running-node cleanup behavior is unchanged
