# Failed-Provisioning Node Cleanup

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - The capacity case cited here: in the TaskRunner descent loop, a capacity failure that
>     never created a VM now deletes the node row instead of leaving it in `error`
>     (`apps/api/src/services/node-provisioning.ts:727-747`; #1210, #2030).
>   - A slow backstop for task-provisioned nodes: the max-lifetime sweep covers every status
>     except stopped/destroying/deleted, so an `error` node is destroyed (with a provider delete)
>     once it passes `MAX_AUTO_NODE_LIFETIME_MS`, 4h by default
>     (`apps/api/src/scheduled/node-cleanup/node-phases.ts:133-160`).
> - **Still open:**
>   - A dedicated sweep for `status='error'` nodes of every origin, not only task-provisioned
>     ones, with a configurable threshold (about 30 min by default) and an idempotent provider
>     delete. Other provisioning failures still write `status='error'`
>     (`node-provisioning.ts:749-780`); staging produced such rows on 2026-09-25 (see
>     `tasks/backlog/2026-09-25-staging-allocation-plan-no-longer-current.md`).
>   - Tests for the error-node path; none exist today.

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
