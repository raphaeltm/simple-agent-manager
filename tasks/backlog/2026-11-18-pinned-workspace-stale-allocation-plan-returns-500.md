# Pinned workspace creation returns HTTP 500 when node allocation authority is stale

## Problem

`POST /api/workspaces` with an explicit `nodeId` on a managed node calls
`assertNodeAllocationPlanCurrent()` directly
(`apps/api/src/routes/workspaces/workspace-create.ts`, managed-node branch). That guard
(`apps/api/src/services/node-allocation-validation.ts`) throws plain `Error`s for
authority drift (`Node allocation plan is no longer current`, `Selected capacity
authority changed after placement`, ...). Plain errors reach the global `app.onError`
handler and become HTTP 500, although the condition is a caller-fixable conflict
(the pool source was excluded, the credential rotated, the attachment was revoked).

## Context

Found by code inspection during PR #2853 (exact composable credential pool anchors,
task `tasks/active/2026-09-25-composable-capacity-source-anchor-guard.md`). Pre-existing;
not introduced by that PR. The guard correctly refuses (no workspace is created); only
the status code and error category are wrong. A 5xx also pollutes staging/production
error groups and is reported as a server fault (rule 72: categorize by recovery action).

## Acceptance Criteria

- [ ] Authority-drift refusals from the allocation guard surface as a designed 409 (or 400)
      with a stable error code on pinned workspace creation; genuine faults (database
      unavailable) stay 5xx. Prefer a typed error over message matching.
- [ ] Same mapping reviewed for the other `assertNodeAllocationPlanCurrent` callers in
      `node-provisioning.ts` (task-runner paths may intentionally treat it as a failure).
- [ ] Route-level test on a real SQL engine: exclude the node's pool source, then a pinned
      create returns the designed 4xx and creates no workspace row; owner-path control
      with the source included succeeds.
