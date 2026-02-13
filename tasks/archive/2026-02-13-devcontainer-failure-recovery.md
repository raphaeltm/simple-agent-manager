# Devcontainer Failure Recovery & Workspace Rebuild

## Summary

When a workspace's devcontainer fails to build (e.g. bad Dockerfile, failing postCreateCommand), the workspace currently transitions straight to `error` and the user is stuck. Instead, we should fall back to a default devcontainer so the user (or their agent) can diagnose and fix the issue from inside the workspace.

Two related capabilities:

1. **Graceful fallback on devcontainer failure**: When `devcontainer up` fails, retry with the default base image, inject the failure logs into a well-known file, and mark the workspace as running (degraded).
2. **Workspace rebuild trigger**: Allow users to trigger a devcontainer rebuild from the UI after fixing the devcontainer config, without deleting and recreating the workspace.

## Detailed Behavior

### Fallback on Failure

1. `devcontainer up` with the repo's config fails
2. VM agent captures the full error output (stdout + stderr)
3. VM agent retries with `--override-config` using the default base image (same as repos without devcontainer config)
4. On successful fallback boot, write failure logs to a file inside the container (e.g. `/workspaces/<id>/.devcontainer-build-error.log`)
5. Optionally write a summary to a more visible location (e.g. a MOTD or terminal banner on first attach)
6. Report workspace as `running` with a flag indicating degraded/fallback mode (e.g. `devcontainerFallback: true` in workspace metadata)
7. If even the fallback fails, then transition to `error` as today

### Workspace Rebuild

1. New API endpoint: `POST /api/workspaces/:id/rebuild`
2. Tears down the existing devcontainer (stops container, removes it)
3. Re-runs `devcontainer up` with the repo's config (user may have fixed it)
4. If rebuild fails, applies the same fallback logic above
5. UI button in workspace toolbar or sidebar: "Rebuild Container"

## Acceptance Criteria

- [ ] Devcontainer build failure does not leave workspace in `error` — falls back to default image
- [ ] Failure logs are accessible inside the fallback container at a well-known path
- [ ] Workspace response indicates when running in fallback/degraded mode
- [ ] User can trigger a rebuild from the UI
- [ ] Rebuild re-attempts the repo's devcontainer config
- [ ] Rebuild applies the same fallback logic if it fails again
- [ ] Event log records both the original failure and the fallback

## Files Likely Affected

### VM Agent (Go)
- `internal/server/workspaces.go` — new rebuild handler, fallback logic in provisioning
- `internal/server/provisioning.go` (or equivalent) — devcontainer up retry with fallback
- `internal/server/routes` — register `POST /workspaces/{workspaceId}/rebuild`

### API (TypeScript)
- `apps/api/src/routes/workspaces.ts` — new `POST /api/workspaces/:id/rebuild` that proxies to VM agent
- `packages/shared/src/types.ts` — add `devcontainerFallback` field to `WorkspaceResponse`

### Web (React)
- `apps/web/src/pages/Workspace.tsx` — rebuild button, degraded mode indicator
- `apps/web/src/lib/api.ts` — `rebuildWorkspace()` client function

## Notes

- The fallback image should be the same one used for repos without devcontainer config (`DEFAULT_DEVCONTAINER_IMAGE`)
- Consider showing the build error in the UI sidebar/event log as well, not just in-container
- The rebuild flow is similar to restart but specifically targets the devcontainer layer, not the full workspace
