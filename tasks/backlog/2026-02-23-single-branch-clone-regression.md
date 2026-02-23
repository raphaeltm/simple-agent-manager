# Single-Branch Clone Regression

**Created**: 2026-02-23
**Priority**: High
**Classification**: `cross-component-change`, `infra-change`

## Context

SAM workspaces clone git repos with `--single-branch`, meaning users can only see/fetch the branch they started with. Running `git fetch` does not show `origin/main` or any other remote branches. This is a regression — users expect full repository access within their workspaces.

The root cause is in `packages/vm-agent/internal/bootstrap/bootstrap.go` line 604:

```go
cmd := exec.CommandContext(ctx, "git", "clone", "--branch", branch, "--single-branch", cloneURL, cfg.WorkspaceDir)
```

The `--single-branch` flag restricts the fetch refspec to only the specified branch.

## Root Cause Analysis

- `ensureRepositoryReady()` in `bootstrap.go:562-635` performs the git clone
- The `--single-branch` flag was likely added as a performance optimization (faster clone by fetching only one branch)
- After cloning, `bootstrap.go` sanitizes the git origin URL to remove embedded credentials
- The workaround is `git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'` followed by `git fetch`, but this shouldn't be necessary

## Plan

Remove `--single-branch` from the git clone command. The `--branch` flag alone will check out the desired branch while still fetching all refs.

## Detailed Tasklist

- [ ] Edit `packages/vm-agent/internal/bootstrap/bootstrap.go:604` — remove `"--single-branch"` from the git clone args
- [ ] Verify the clone still checks out the correct branch (the `--branch` flag handles this)
- [ ] Check if there are any other `--single-branch` usages in the codebase (grep for it)
- [ ] Update any tests in `bootstrap_test.go` that assert on the clone command args
- [ ] Run `go vet` and `go test` in `packages/vm-agent/`
- [ ] Run full build to confirm no regressions

## Files to Modify

| File | Change |
|------|--------|
| `packages/vm-agent/internal/bootstrap/bootstrap.go` | Remove `--single-branch` from clone command (line 604) |
| `packages/vm-agent/internal/bootstrap/bootstrap_test.go` | Update tests if they assert on clone args |
