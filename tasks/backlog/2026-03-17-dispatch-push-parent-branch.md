# Push parent branch before dispatching child tasks

## Problem

When an agent dispatches a child task, the child might benefit from starting on the parent's branch (to build on in-progress work). Currently we default to `main` because the parent's output branch may not be pushed yet.

A better UX would be: when `dispatch_task` is called without an explicit `branch`, automatically push the parent's output branch to the remote before cloning, so the child can start from the parent's latest state.

## Context

- Fixed in commit `53f1e86`: removed the broken default that tried to use the parent's unpushed branch, causing `git clone` failures
- The current safe default is `project.defaultBranch` (usually `main`)
- The improvement would be to push the parent branch as part of the dispatch flow, then use it as the checkout branch

## Possible Approaches

1. **API-side push**: The `dispatch_task` handler could trigger a git push on the parent's workspace before creating the child task. Requires the parent workspace to be running and accessible.
2. **Agent-side instruction**: Update the `dispatch_task` tool description to instruct agents to push their branch before dispatching if they want the child to build on it. Simpler but relies on agent compliance.
3. **Hybrid**: Try to push via the parent workspace; if it fails (workspace not running, no changes), fall back to `main` silently.

## Acceptance Criteria

- [ ] Child tasks can optionally start from the parent's current working state
- [ ] No `git clone` failures when the parent hasn't pushed
- [ ] Clear semantics: agent knows whether the child will start from their branch or main
