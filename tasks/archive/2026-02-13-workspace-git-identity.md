# Workspace Git Identity

**Status**: active
**Created**: 2026-02-13
**Priority**: medium

## Goal

Wire authenticated user's git identity (name + email) from the API through to the VM agent so workspaces have correct `git config user.name` and `user.email` set during provisioning.

## Context

The git identity infrastructure was 95% complete:
- `ProvisionState` struct already had `GitUserName` and `GitUserEmail` fields
- `bootstrap.go` already resolved git identity and applied `git config --system`
- `BootstrapTokenData` shared type already had the fields
- The data was never passed from the API to the VM agent during workspace creation

## Checklist

- [x] API: Add `gitUserName` and `gitUserEmail` to `createWorkspaceOnNode()` workspace parameter
- [x] API: Update `scheduleWorkspaceCreateOnNode()` to accept and forward git identity
- [x] API: Pass `auth.user.name` and `auth.user.email` from POST handler
- [x] VM Agent: Add `GitUserName` and `GitUserEmail` to `WorkspaceRuntime` struct
- [x] VM Agent: Parse git identity from create workspace request body
- [x] VM Agent: Pass git identity from runtime to `ProvisionState` in provisioning
- [x] TypeScript typecheck passes
- [x] Go build passes
- [x] All existing tests pass

## Implementation Notes

- `auth.user.name` is `string | null`, `auth.user.email` is `string` (from BetterAuth `AuthContext`)
- The API sends `gitUserName` and `gitUserEmail` as optional fields in the JSON body
- The VM agent stores them on the `WorkspaceRuntime` struct and passes them to `bootstrap.PrepareWorkspace`
- The existing `resolveGitIdentity()` and `configureGitSystem()` in bootstrap.go handle the rest
