# Fix: Git identity not configured in conversation-mode workspaces

## Problem

Conversation-mode (lightweight) workspaces do not have `git user.name` and `git user.email` configured. Agents cannot commit without manually setting git identity first.

## Context

Discovered while working in a conversation-mode SAM workspace. `git commit` failed with "Author identity unknown" because no git identity was set at the system level inside the devcontainer.

## Root Cause

The API sends `gitUserName` and `gitUserEmail` to the VM agent as part of the workspace provisioning payload. These values come from the user's GitHub profile (stored in the `users` table: `name`, `email`, `githubId`).

Two issues exist:

### 1. Conversation-mode workspace creation may not populate git identity fields

The `createWorkspaceOnNode()` call in `apps/api/src/routes/workspaces/_helpers.ts` passes `gitUserName` and `gitUserEmail`, but the caller may not be providing them for conversation-mode workspaces. Need to trace the full call chain from the UI "create workspace" action to verify.

### 2. Recovery path omits git identity entirely

In `packages/vm-agent/internal/server/workspace_provisioning.go` (line ~158), the recovery path creates an empty `ProvisionState{}` and only populates `GitHubToken`, `ProjectEnvVars`, `ProjectFiles`, and `Lightweight`. It never sets `GitUserName`, `GitUserEmail`, or `GitHubID`, so any workspace that goes through recovery will lose its git identity.

## Relevant Code Paths

- **VM agent provisioning**: `packages/vm-agent/internal/server/workspace_provisioning.go`
  - Primary path (line ~102): Correctly passes `runtime.GitUserName`, `runtime.GitUserEmail`, `runtime.GitHubID`
  - Recovery path (line ~158): Creates empty `ProvisionState{}`, omits git identity fields
- **Git identity setup**: `packages/vm-agent/internal/bootstrap/bootstrap.go:ensureGitIdentity()` (line ~1770)
  - Sets `git config --system user.name/user.email` inside the devcontainer via `docker exec`
  - Silently skips if email is empty (returns nil, not an error)
- **Identity resolution**: `bootstrap.go:resolveGitIdentity()` (line ~1735)
  - Has noreply email fallback using GitHub ID, but requires at least email or GitHub ID
- **API workspace creation**: `apps/api/src/routes/workspaces/_helpers.ts:provisionWorkspaceOnNode()`
  - Passes `gitUserName` and `gitUserEmail` from caller
- **User table**: `apps/api/src/db/schema.ts` - `users` table has `name`, `email`, `githubId`

## Acceptance Criteria

- [ ] Conversation-mode workspaces have `git user.name` and `git user.email` configured after provisioning
- [ ] Recovery path populates `GitUserName`, `GitUserEmail`, and `GitHubID` from the workspace's runtime data
- [ ] If the user has no public email, the noreply fallback (`<githubId>+<login>@users.noreply.github.com`) is used
- [ ] `ensureGitIdentity` logs a warning (not silent skip) when identity cannot be resolved
- [ ] Existing task-mode workspace git identity is unaffected (regression check)
