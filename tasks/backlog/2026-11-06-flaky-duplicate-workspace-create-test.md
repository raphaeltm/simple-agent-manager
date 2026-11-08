# Flaky vm-agent test: TestCreateWorkspaceDuplicateProvisioningReturnsIdempotentAccepted can deadlock

## Problem

`packages/vm-agent/internal/server/workspaces_test.go`
`TestCreateWorkspaceDuplicateProvisioningReturnsIdempotentAccepted` occasionally hangs until the package
test timeout (10 min in CI), failing the whole `VM Agent Test` job.

Goroutine dump from a local reproduction: the second create request is blocked in
`workspaceLifecycleHandle.Lock` (`workspaces.go` create handler → `workspace_lifecycle_lock.go`),
waiting on the lifecycle lock held by the provisioning goroutine. That goroutine is blocked in the
test's stubbed `prepareWorkspaceForRuntime` on `<-release`, and the test closes `release` only after
both create responses return (`wg.Wait()`). If the second request reads
`ProvisioningActive` before the first request sets it, it skips the idempotent early return and
queues on the lock, so the test deadlocks. Timing-dependent; it does not indicate a product bug by
itself, but it can block `main` CI and therefore production deploys.

## Context

- Seen on `main` CI run 42203232773 (attempt 1) for merge commit `734bb04c1` (PR #2550, unrelated
  change); the job passed on re-run.
- Reproduced locally on `734bb04c1` with `go test ./internal/server/ -run TestCreateWorkspaceDuplicateProvisioningReturnsIdempotentAccepted -count=300`
  (2 of 4 batches hung; the other 2 passed). The pre-change base `83c87df44` passed 3 batches (900
  runs) in the same session. PR #2550 does not touch the create handler, the lifecycle lock or the
  provisioning path (`workspaces.go`, `workspace_lifecycle_lock.go`, `workspace_provisioning.go`), so
  the difference is attributed to timing; confirm with a larger sample when fixing.

## Acceptance Criteria

- [ ] Decide whether a duplicate create that races past the `ProvisioningActive` check should also
      return the idempotent 202 without waiting behind provisioning (product behavior), or whether only
      the test needs to order its requests.
- [ ] The test cannot deadlock: it releases provisioning on a bounded timeout or drives the
      second request after the first is admitted.
- [ ] `-count=1000` of this test passes locally.
