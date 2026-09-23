# Fix stopped Hetzner node cleanup handoff

## Problem

Warm auto-provisioned nodes can end up recorded as `stopped` instead of being deleted from the cloud provider. These nodes are useless to SAM but can still cost money in Hetzner if the provider VM remains present.

## Research Findings

- `apps/api/src/durable-objects/node-lifecycle.ts` marks expired warm nodes as DO state `destroying`, but writes D1 `nodes.status = 'stopped'` and clears `warm_since`.
- `apps/api/src/scheduled/node-cleanup.ts` only destroys stale warm nodes where `status = 'running'` and `warm_since IS NOT NULL`.
- The max-lifetime cleanup excludes `status IN ('stopped', 'deleted')`, so it also skips NodeLifecycle alarm handoff nodes.
- Production D1 showed a stopped node with a provider instance and deleted workspace, matching the leak shape.
- Existing tests cover stale warm `running` nodes and stopped workspace deletion, but not the DO alarm -> cron provider deletion handoff.

## Implementation Checklist

- [x] Add regression coverage for stopped auto-provisioned nodes left by NodeLifecycle alarm.
- [x] Add cron cleanup phase that discovers stopped auto-provisioned nodes with no active workspaces.
- [x] Call `deleteNodeResources` for those nodes and mark them deleted after successful cleanup.
- [x] Preserve active-workspace safety: never delete stopped nodes that still have active workspaces.
- [x] Run focused unit and worker tests where possible.
- [x] Run applicable quality checks.
- [ ] Deploy through staging and production via GitHub Actions, not direct Wrangler.

## Acceptance Criteria

- Cron cleanup attempts provider deletion for stopped auto-provisioned nodes with no active workspaces.
- Existing warm-node and max-lifetime cleanup behavior remains intact.
- Regression test fails before the fix and passes after the fix.
- Production deploy completes successfully.
