# Deployment Provisioning Route-Level Behavioral Tests + Resilience

**Created**: 2026-06-12
**Source**: Late-arriving test-engineer + security-auditor reviews on PR #1302 (deployment node provisioning)
**Priority**: MEDIUM

## Problem

The deployment provisioning service (`deployment-provisioning.ts`) has solid behavioral tests, but the route-level provisioning trigger in `deployment-releases.ts` (lines 248-279) lacks behavioral test coverage. The existing tests for the route use source-contract patterns (reading source as string + `toContain()`), which are banned by rule 02 for behavioral code.

Additionally, the security auditor identified a resilience gap: if `provisionNode` fails inside the `.catch()`, the environment keeps a stale `nodeId` pointing to a node stuck in `creating` state, preventing re-provisioning on subsequent releases.

## Gaps to Address

1. **Replace source-contract tests with behavioral tests** for the provisioning trigger in the release route:
   - First release to an environment without a node triggers `provisionDeploymentNode()`
   - Second release to an environment that already has a node does NOT re-provision
   - `provisionDeploymentNode` returning `null` (no credentials) still returns 201 with `nodeId: null`
   - `provisionDeploymentNode` throwing still returns 201 (error is caught and logged)

2. **Replace source-contract DNS skip test** with a spy-based behavioral test asserting `createNodeBackendDNSRecord` is not called when `deploymentContext` is set.

3. **Replace workspace-creation quota source-contract test** with a behavioral mock test.

4. **Roll back `nodeId` on provisioning failure** (security-auditor finding): When `provisionNode` rejects inside the `.catch()` in `deployment-provisioning.ts`, issue `UPDATE deploymentEnvironments SET nodeId = NULL WHERE id = envId` so subsequent release submissions can re-trigger provisioning. Without this, a provisioning failure permanently orphans the environment.

## What Is NOT a Gap (Reviewer Errors)

- The env-to-node link update IS asserted in "links environment to node via conditional UPDATE" test
- The DNS skip IS tested behaviorally via deployment context assertion on `provisionNode`
- The heartbeat IDOR was already fixed in commit fa1a5452 (resolves envId from node placement, not request body)
- The FK ON DELETE SET NULL and node_id index were already added in commit fa1a5452
- The concurrent-release race was already fixed with conditional UPDATE WHERE node_id IS NULL

## Acceptance Criteria

- [ ] All source-contract tests in `deployment-provisioning.test.ts` replaced with behavioral `app.request()` tests
- [ ] Route-level test covers first-release provisioning trigger
- [ ] Route-level test covers skip-provisioning-when-node-exists branch
- [ ] Route-level test covers null-return and throw paths
- [ ] DNS skip tested with spy on `createNodeBackendDNSRecord`
- [ ] Provisioning failure rolls back environment `nodeId` to NULL
- [ ] Test covers provisioning-failure rollback behavior
- [ ] All tests pass
