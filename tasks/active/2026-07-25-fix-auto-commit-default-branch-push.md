# Fix VM-Agent Auto-Commit Pushing to Default Branch

## Problem

The VM-agent's `gitPushWorkspaceChanges` function (server.go:1517) pushes `HEAD` to origin unconditionally after auto-committing agent work on task completion. Workspaces are always cloned with the project's default branch (e.g. `main`). The task's `outputBranch` is stored in the database and communicated to the agent as metadata, but the workspace itself is never checked out to that branch server-side.

If the agent never switches branches during its work (e.g., it crashes early, doesn't follow `/do` workflow instructions, or the branch-switch instruction is lost), `gitPushWorkspaceChanges` auto-commits and pushes directly to `origin/main` — contaminating the default branch with partial or broken agent work.

## Root Cause

The auto-commit path in `makeTaskCompletionCallback` (server.go:1296) calls `gitPushWorkspaceChanges(workspaceID, false)` at line 1359. This function:

1. Runs `git status --porcelain` to check for changes
2. Runs `git add -A` to stage all changes
3. Runs `git commit -m "chore: save agent work"`
4. Runs `git rev-parse --abbrev-ref HEAD` to get branch name (for reporting only, **not for validation**)
5. Runs `git push --set-upstream origin HEAD` (line 1567) — pushes whatever HEAD is

There is **no guard** to reject pushes when HEAD equals the project's default branch. The branch name is captured after commit but never compared against any forbidden value.

## Key Code Paths

- **Task dispatch**: `scheduling.ts:363` — `branch: projectRow.default_branch` (workspace always gets default branch)
- **Workspace creation on VM agent**: `workspace-steps.ts:410` — `branch: state.config.branch` (default branch)
- **VM agent workspace creation request**: `workspaces.go:467` — `createWorkspaceRequest` has `Branch` but no `DefaultBranch` field
- **WorkspaceRuntime struct**: `server.go:143` — has `Branch` but no `DefaultBranch`
- **Auto-commit push**: `server.go:1517` — `gitPushWorkspaceChanges` pushes HEAD unconditionally
- **Completion callback**: `server.go:1359` — calls `gitPushWorkspaceChanges(workspaceID, false)` on success

## Fix Approach

### 1. Add `DefaultBranch` to the VM-agent workspace data flow

- Add `DefaultBranch` field to `createWorkspaceRequest` (workspaces.go:467)
- Add `DefaultBranch` field to `WorkspaceRuntime` (server.go:143)
- Populate `DefaultBranch` in `createWorkspaceRuntimeOptions` (workspaces.go:509)
- Pass `defaultBranch` from the API side in `createWorkspaceOnNode` payload (node-agent.ts:287, workspace-steps.ts:407)

### 2. Add default-branch guard in `gitPushWorkspaceChanges`

- After resolving the current branch name (`git rev-parse --abbrev-ref HEAD`), compare it against `DefaultBranch` from `WorkspaceRuntime`
- If HEAD matches the default branch, refuse to push and return an error in the `gitPushResult`
- Move the branch name resolution BEFORE the push (currently happens after commit but the check order should be: detect branch → validate → push)

### 3. Regression tests

- Test that `gitPushWorkspaceChanges` blocks pushes when HEAD is on the default branch
- Test that pushes still work when HEAD is on a different branch (output branch)
- Test that the `DefaultBranch` field flows correctly from create request to runtime

## Implementation Checklist

- [ ] Add `DefaultBranch` field to `createWorkspaceRequest` struct (workspaces.go)
- [ ] Add `DefaultBranch` field to `WorkspaceRuntime` struct (server.go)
- [ ] Wire `DefaultBranch` through `workspaceRuntimeOpts` and populate it in the runtime (workspaces.go)
- [ ] Add `defaultBranch` to the API-side workspace creation payload (`node-agent.ts` and `workspace-steps.ts`)
- [ ] In `gitPushWorkspaceChanges`, move branch resolution before the push step
- [ ] Add guard: if current branch equals `WorkspaceRuntime.DefaultBranch`, refuse to push with diagnostic error
- [ ] Add regression test: push blocked when HEAD == default branch
- [ ] Add regression test: push succeeds when HEAD != default branch
- [ ] Add test: DefaultBranch field flows from create request to runtime
- [ ] Run `go test ./...` in vm-agent, `pnpm typecheck`, `pnpm lint`

## Acceptance Criteria

- [ ] Auto-commit on task completion does NOT push to the project's default branch
- [ ] Auto-commit on task completion DOES push to non-default branches (no breaking change)
- [ ] The `gitPushResult.Error` contains actionable diagnostics when a default-branch push is blocked
- [ ] At least one regression test proves the default-branch guard works
- [ ] At least one test proves non-default-branch pushes still succeed
- [ ] All existing tests pass, lint/typecheck clean

## Constraints

- **NO BREAKING CHANGES**: Existing successful task completion behavior for agents that correctly check out their task branch must be preserved
- **DO NOT MERGE**: PR should be created but left open for human review
- Output branch: `sam/retry-failed-remediation-task-ftg8sw`

## References

- Task ID: `01KYC38XSNRAVN9PMZ7MFTG8SW`
- Retry of failed task: `01KYC37GDCDZ6YGNEAB1BGHX2X`
