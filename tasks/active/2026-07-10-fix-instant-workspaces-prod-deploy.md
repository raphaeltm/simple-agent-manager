# Fix Instant Workspaces Production Deploy

## Problem

The instant workspaces UI is missing in production because PR #1544 merged to `main` but the production deploy did not run for merge commit `e4bf15e95`. CI failed on the `VM Agent Test` job, so `Deploy Production` run `29058133492` was skipped.

## Evidence

- PR #1544 merged at `2026-07-09T23:36:38Z` with merge commit `e4bf15e95`.
- CI run `29057826390` failed in `packages/vm-agent` with `TestRunDetachedDeploymentApplyCancelsAfterIdleProgress`.
- Failure detail: `health_test.go:145: deploy-release endpoint was not requested`.
- Production Worker `sam-api-prod` was last modified at `2026-07-09T11:40:28Z`, matching the last successful deploy for commit `9b8cd9a3`.
- Production D1 migrations stop at `0087_platform_settings.sql`; `0088_node_runtime.sql` and `0089_profile_skill_runtime.sql` are absent.
- Production app bundle `/assets/index-BRP7_3RA.js` lacks `Instant container` and `cf-container`.

## Research Findings

- Failing test: `packages/vm-agent/internal/server/health_test.go`.
- Related production code: `packages/vm-agent/internal/server/health.go` and deployment apply idle watchdog logic.
- The test currently uses a very small `DeployApplyIdleTimeout` and expects the HTTP request to reach the local test server before the watchdog cancels the operation.
- Under GitHub Actions load, the idle watchdog can fire before the request reaches the handler, producing a test-only race.
- The fix should preserve production idle-timeout behavior and make the test deterministic.

## Checklist

- [x] Reproduce or directly verify the VM-agent test failure mode locally.
- [x] Patch the test or its test-only harness to remove timing dependence without weakening production behavior.
- [x] Run focused VM-agent tests for the affected package.
- [x] Run broader VM-agent Go tests with race detector if local toolchain allows.
- [ ] Push a PR and verify GitHub CI turns green.
- [ ] Deploy to staging and verify the instant-workspaces schema/UI evidence on staging.
- [ ] Merge once checks and staging pass.
- [ ] Monitor production deploy to completion.
- [ ] Verify production D1 has migrations `0088`/`0089` and production web bundle contains `cf-container`.

## Acceptance Criteria

- `VM Agent Test` passes in CI for the fix commit.
- Production deploy runs successfully after merge.
- Production D1 includes `0088_node_runtime.sql` and `0089_profile_skill_runtime.sql`.
- Production app bundle includes the instant runtime UI strings/enums.
- The UI exposes the instant workspace runtime option after production deploy.
