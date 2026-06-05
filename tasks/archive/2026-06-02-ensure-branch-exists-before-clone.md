# Ensure Branch Exists Before Clone

## Problem

When tasks are dispatched with an explicit `branch` parameter (via MCP `dispatch_task`), the branch may not exist on the remote yet. The VM agent's `git clone --branch <branch>` fails with:

```
Task failed: git clone failed: exit status 128: Cloning into '/workspace/...'...
fatal: Remote branch sam/platform-policy-github-token-scope not found in upstream origin
```

This happens because `dispatch_task` allows callers to specify a branch name (line 419 in `dispatch-tool.ts`: `const checkoutBranch = explicitBranch || project.defaultBranch`), but no code ensures that branch actually exists on the remote before the workspace tries to clone it.

## Root Cause

The flow is:
1. `dispatch_task` or `submit` creates a task with `branch` = explicit branch or project default branch
2. `TaskRunnerDO` → `createAndProvisionWorkspace()` → `createWorkspaceOnVmAgent()` passes `branch` to the VM agent
3. VM agent runs `git clone --branch <branch> <url>` which fails if the branch doesn't exist

There's no validation step between task creation and workspace provisioning that verifies the branch exists on the remote.

## Research Findings

- **Task dispatch flow**: `dispatch-tool.ts` line 419 allows explicit branch parameter
- **Workspace creation**: `workspace-steps.ts:createAndProvisionWorkspace()` passes `state.config.branch` to VM agent
- **VM agent clone**: `bootstrap.go:ensureRepositoryReady()` runs `git clone --branch <branch>`
- **GitHub API exists**: `github-app.ts:getRepositoryBranches()` already lists branches via installation tokens
- **Repository parsing**: `parseRepository()` helper exists in `sam-session/tools/helpers.ts`
- **Installation token**: `getInstallationToken()` in `github-app.ts` provides auth for GitHub API
- **Config has all needed data**: `TaskRunConfig` has `repository`, `installationId`, and `branch`

## Implementation Plan

### 1. Add `ensureBranchExists()` function to `github-app.ts`

New function that:
- Takes `installationId`, `owner`, `repo`, `branchName`, `defaultBranch`, `env`
- Calls GitHub API `GET /repos/{owner}/{repo}/branches/{branch}` to check if branch exists
- If it exists, return early
- If not (404), get the SHA of the default branch via `GET /repos/{owner}/{repo}/git/ref/heads/{defaultBranch}`
- Create the branch via `POST /repos/{owner}/{repo}/git/refs` with `{ ref: "refs/heads/{branchName}", sha: <defaultBranchSha> }`

### 2. Call `ensureBranchExists()` in `workspace-steps.ts`

In `createAndProvisionWorkspace()`, after workspace DB insertion and before `createWorkspaceOnVmAgent()`:
- Parse `owner/repo` from `state.config.repository`
- If `state.config.branch` differs from the project's default branch, call `ensureBranchExists()`
- This is a best-effort step — if the GitHub App doesn't have permissions or the repo isn't accessible, log a warning and proceed (the clone will fail with a clearer error from the VM agent)

### 3. Add tests

- Unit test for `ensureBranchExists()` — mock GitHub API responses
- Integration test for the workspace creation flow with branch auto-creation

## Implementation Checklist

- [ ] Add `ensureBranchExists()` function to `apps/api/src/services/github-app.ts`
- [ ] Add `parseRepository` utility to shared location or import from helpers
- [ ] Call `ensureBranchExists()` in `workspace-steps.ts:createAndProvisionWorkspace()` before `createWorkspaceOnVmAgent()`
- [ ] Look up the project's default branch from D1 to compare against `state.config.branch`
- [ ] Add unit tests for `ensureBranchExists()`
- [ ] Add integration/capability test for the workspace creation flow with branch auto-creation
- [ ] Run typecheck, lint, test, build

## Acceptance Criteria

- [ ] When a task is dispatched with a branch that doesn't exist on the remote, the branch is automatically created from the repo's default branch before cloning
- [ ] When a task uses the project's default branch, no extra GitHub API call is made
- [ ] When branch creation fails (permissions, network), the task proceeds and fails with the original clone error (not a crash)
- [ ] Tests cover: branch exists (no-op), branch doesn't exist (created), API failure (graceful fallback)

## References

- `apps/api/src/routes/mcp/dispatch-tool.ts` — MCP dispatch with explicit branch
- `apps/api/src/durable-objects/task-runner/workspace-steps.ts` — workspace creation flow
- `apps/api/src/services/github-app.ts` — existing GitHub API integration
- `packages/vm-agent/internal/bootstrap/bootstrap.go` — VM agent git clone
