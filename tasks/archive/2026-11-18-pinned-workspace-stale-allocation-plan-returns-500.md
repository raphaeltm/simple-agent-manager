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

- [x] Authority-drift refusals from the allocation guard surface as a designed 409 (or 400)
      with a stable error code on pinned workspace creation; genuine faults (database
      unavailable) stay 5xx. Prefer a typed error over message matching.
- [x] Same mapping reviewed for the other `assertNodeAllocationPlanCurrent` callers in
      `node-provisioning.ts` (task-runner paths may intentionally treat it as a failure).
- [x] Route-level test on a real SQL engine: exclude the node's pool source, then a pinned
      create returns the designed 4xx and creates no workspace row; owner-path control
      with the source included succeeds.

## Resolution (PR #2853, 2026-11-19)

- `node-allocation-validation.ts` throws `NodeAllocationAuthorityChangedError` (an `Error` subclass,
  same messages) for record/owner/plan/settings/authority drift. A database outage stays a plain `Error`.
- The pinned route calls `assertPinnedNodeAllocationPlanCurrent`, which maps that error to
  `409 CONFLICT`. The `node-provisioning.ts` callers keep calling `assertNodeAllocationPlanCurrent`:
  for them drift fails the provisioning attempt, so their behavior is unchanged. The node-pool
  boundary inventory now names the wrapper as the route's evidence.
- Tests (`node-allocation-plan-guard-composable.test.ts`, migrated SQLite): the owner control
  passes, an excluded source answers 409 with no workspace created, and an unavailable database is
  not a 409. With the typed error removed, the 409 test fails. The route itself is exercised live by
  the staging kit's excluded-source probe.
- Security review (PASS, LOW notes addressed): the wrapper logs `node_allocation.pinned_authority_refused`
  with node, user and project IDs plus `action: 'rejected'` (rule 11), and the 409 names the recovery
  action ("Choose another node or omit nodeId."). Deferred LOW: a route-level unit test of the pinned
  409, since added as `apps/api/tests/unit/routes/workspace-create-pinned-authority.test.ts`
  (real route, real SQL; owner control 201, excluded source 409, no row; pointing the route at
  the unwrapped guard makes it fail with the old 500). Live staging on `74aa64128` also returned
  409 with 0 rows.
