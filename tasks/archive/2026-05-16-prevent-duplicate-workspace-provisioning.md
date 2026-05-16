# Prevent Duplicate Workspace Provisioning

## Problem

Two concurrent `POST /workspaces` requests for the same workspace ID can both update the runtime to `creating` and launch separate provisioning goroutines. That can create two devcontainers for one workspace and inject project runtime environment variables into the wrong container.

## Research Findings

- `handleCreateWorkspace` in `packages/vm-agent/internal/server/workspaces.go` currently calls `upsertWorkspaceRuntime`, appends a provisioning event, and unconditionally calls `startWorkspaceProvision`.
- `startWorkspaceProvision` launches the async goroutine and centralizes success/failure status transitions. It is the right place to clear any in-flight provisioning marker.
- `upsertWorkspaceRuntime` in `packages/vm-agent/internal/server/workspace_routing.go` already holds `workspaceMu` while creating/updating a runtime and must remain in place so duplicate requests can refresh metadata.
- `WorkspaceRuntime` is currently defined in `packages/vm-agent/internal/server/server.go`, not `workspace_routing.go` as the task text states.
- Existing provisioning tests use the `prepareWorkspaceForRuntime` package variable as a test seam, with an `httptest.Server` control plane for runtime asset responses.
- The referenced note `docs/notes/2026-05-16-duplicate-workspace-dispatch-env-var-loss-postmortem.md` is not present in this checkout. Related notes reviewed:
  - `docs/notes/2026-03-05-workspace-restart-stale-error-postmortem.md`: lifecycle transitions need complete state cleanup.
  - `docs/notes/2026-05-04-devcontainer-gitconfig-lock-postmortem.md`: provisioning has real concurrency-sensitive side effects inside containers.
  - `docs/notes/2026-03-25-env-var-single-quote-stripping-postmortem.md`: environment variable delivery bugs need production-shaped tests.

## Checklist

- [x] Add `ProvisioningActive bool` to `WorkspaceRuntime`.
- [x] Add an atomic duplicate-provisioning check/set in `handleCreateWorkspace` immediately after `upsertWorkspaceRuntime`.
- [x] Return idempotent `202 {"workspaceId": ..., "status": "creating"}` when a create request arrives while provisioning is active.
- [x] Clear `ProvisioningActive` with a defer at the top of the `startWorkspaceProvision` goroutine.
- [x] Add concurrent create coverage proving only one provisioning run starts for duplicate workspace creates.
- [x] Add coverage proving a later create can start provisioning again after the first provisioning run completes and clears the flag.
- [ ] Run focused VM agent tests. Blocked locally: `go` and `gofmt` are not installed in this workspace.
- [x] Run relevant repo quality checks or document blockers.

## Validation

- `pnpm typecheck` passed.
- `pnpm lint` passed with existing warnings.
- `pnpm test` passed.
- `pnpm build` exited successfully; the direct `pnpm --filter @simple-agent-manager/www build` rerun also passed after Turbo replayed a stale cached Astro error log.
- Focused VM agent tests and `gofmt` were blocked locally because `go` and `gofmt` are not installed in this workspace.

## Acceptance Criteria

- Duplicate concurrent creates for the same workspace ID are idempotent and do not launch duplicate provisioning goroutines.
- The in-flight guard is cleared after provisioning exits on success or failure.
- No new workspace status is introduced.
- Restart and rebuild behavior remains unchanged.

## References

- `packages/vm-agent/internal/server/workspaces.go`
- `packages/vm-agent/internal/server/workspace_routing.go`
- `packages/vm-agent/internal/server/server.go`
- `packages/vm-agent/internal/server/workspace_provisioning.go`
- `packages/vm-agent/internal/server/workspaces_test.go`
