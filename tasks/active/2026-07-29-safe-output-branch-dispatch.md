# Safe output branch dispatch

## Problem

SAM-dispatched task work can run in a workspace checked out on the repository default branch while `tasks.output_branch` records a separate branch. VM-agent auto-commit-on-completion already has a fail-closed guard that blocks pushing when HEAD is still on the project default branch, but the safer behavior is to create task workspaces on the output branch in the first place.

## Research findings

- `apps/api/src/durable-objects/task-runner/workspace-steps.ts` sends the branch payload to the VM agent during workspace dispatch. Before this change it used `state.config.branch` as the checkout branch even when `state.config.outputBranch` was different.
- `packages/vm-agent/internal/server/server.go` contains an auto-commit guard that blocks default-branch pushes when HEAD equals the project default branch. Existing tests cover default-branch block and output-branch success.
- `apps/api/tests/unit/durable-objects/task-runner-workspace-branch-dispatch.test.ts` already targeted this branch payload contract, including the risky explicit-branch case.

## Implementation checklist

- [x] Change task-runner workspace dispatch to check out `outputBranch` when present.
- [x] Preserve explicit configured branch as the clone base when it differs from `outputBranch`.
- [x] Preserve existing non-default output branch behavior by basing generated output branches on the project default branch.
- [x] Add targeted tests covering generated output branch, explicit non-default branch with separate output branch, and explicit default branch with separate output branch.
- [x] Re-run VM-agent default-branch push guard tests to prove fail-closed protection remains intact.

## Acceptance criteria

- [x] Default branch is not the VM-agent checkout target when task `outputBranch` exists.
- [x] Explicit branch dispatch remains safe: explicit branch is used as the base branch, not the branch that receives task work.
- [x] Existing successful non-default branch behavior still works.
- [x] Public API contracts are unchanged; only internal task-runner-to-VM-agent payload values change.
