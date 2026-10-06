# Auto-commit push guard can block a legitimate push on manually created workspaces

> **Reconciliation 2026-09-30:** still open. Traced in code, not tested live: the fallback may
> also block Instant task-mode output branches (`submit-instant-task.ts:104` passes the output
> branch, `instant-session.ts:432` sends no `defaultBranch`, and the VM agent reads it only from
> the request body at `workspaces.go:606`). Callers that omit `defaultBranch` today:
> `workspaces/_helpers.ts:436`, `trial-orchestrator/steps.ts:755`, `node-lifecycle.ts:243`,
> `instant-session.ts:432`; only `task-runner/workspace-steps.ts:479` sends it.

## Problem

The default-branch push guard added in PR #1672 resolves the protected branch via
`workspaceDefaultBranch()` (`packages/vm-agent/internal/server/server.go:1621-1630`):

```go
if runtime.DefaultBranch != "" { return runtime.DefaultBranch }
return runtime.Branch
```

When `DefaultBranch` is absent it falls back to `Branch` — the workspace's **checkout**
branch. `shouldBlockDefaultBranchPush` then blocks whenever `HEAD == Branch`, which is the
normal state for a workspace that never switched branches.

The task-runner path always sends `defaultBranch`
(`apps/api/src/durable-objects/task-runner/workspace-steps.ts`), so task workspaces are
correct. Manual workspace creation (`apps/api/src/routes/workspaces/crud.ts:205`) resolves
`resolvedBranch` from `body.branch ?? project.defaultBranch` but does not appear to send a
separate `defaultBranch`. On that path a workspace created on, say, `feature/x` can have its
auto-commit push refused with a message asserting `feature/x` **is** "the project default
branch" — which is both a wrong outcome and a wrong diagnosis.

## Context

Found on 2026-08-04 while documenting the push guard in
`apps/www/src/content/docs/docs/guides/idea-execution.md`. The first draft of the docs
claimed "a metadata gap never blocks a legitimate push", which the fallback makes false;
the docs now describe the real behavior, but the behavior itself is still wrong for manual
workspaces.

Not user-reported — task-created workspaces (the common path) are unaffected, so this is
likely latent rather than actively biting anyone.

## Investigation needed

- [ ] Confirm whether `crud.ts` reaches `createWorkspaceOnNode` without `defaultBranch`, or
      whether another layer supplies it
- [ ] Check the same for any other caller that creates a workspace (triggers, retry, deploy)

## Acceptance Criteria

- [ ] Every workspace-creation caller sends the project's actual default branch, or the guard
      distinguishes "unknown default" from "known default" instead of silently reusing the
      checkout branch
- [ ] Go test: a workspace whose `DefaultBranch` is empty and whose `Branch` is a non-default
      branch is **not** blocked (must fail on the current code)
- [ ] Go test: a workspace whose `DefaultBranch` is set is still blocked when `HEAD` matches it
- [ ] Cross-boundary test enumerating every workspace-creation caller's payload, per
      `.claude/rules/23-cross-boundary-contract-tests.md` ("Multiple Callers to the Same Boundary")
- [ ] The "Two limits worth knowing" note in `idea-execution.md` updated once fixed
