# Fix devcontainer fallback reusing stale container from failed first attempt

**Created:** 2026-02-13
**Priority:** High (blocks workspace creation for repos with failing devcontainer configs)
**Component:** `packages/vm-agent/internal/bootstrap/bootstrap.go`

## Problem

When a repo's own devcontainer config fails and the fallback mechanism triggers, `devcontainer up --override-config` reuses the **stale container** from the first failed attempt instead of building a new one from the fallback image.

### Error

```
devcontainer fallback also failed: devcontainer up failed: exit status 1:
Error response from daemon: unable to find user vscode: no matching entries in passwd file
```

### Root Cause

1. Repo has `.devcontainer/devcontainer.json` with a custom image (e.g. `python:3.12-slim`) that has no `vscode` user
2. First `devcontainer up` creates a container from that image → fails during setup
3. Container remains in Docker (stopped or partially started)
4. Fallback runs `devcontainer up --workspace-folder <same-dir> --override-config /etc/sam/default-devcontainer.json`
5. `devcontainer up` finds the existing container for that workspace folder → tries to **reuse** it
6. `--override-config` sets `"remoteUser": "vscode"` → fails because the reused container is built from the repo's image (no `vscode` user), NOT from `base:ubuntu`

The stale container from the first attempt poisons the fallback.

### Secondary Issue

`writeDefaultDevcontainerConfig()` hardcodes `"remoteUser": "vscode"` (line 581). This assumption only works for Microsoft devcontainer images. If `DEFAULT_DEVCONTAINER_IMAGE` is overridden to a non-devcontainer image, it will also fail.

## Fix Plan

### 1. Clean up failed container before fallback (primary fix)

In `ensureDevcontainerReady()`, between lines 501 and 510, add container cleanup:

```go
// Remove the failed container so the fallback gets a clean slate.
if containerID, findErr := findRunningContainer(ctx, cfg); findErr == nil {
    log.Printf("Removing failed container %s before fallback", containerID)
    exec.CommandContext(ctx, "docker", "rm", "-f", containerID).Run()
}
```

Need to also find stopped containers (not just running ones). May need a helper that queries Docker for containers with the workspace label in any state:

```go
docker ps -a --filter "label=<key>=<value>" --format "{{.ID}}"
```

### 2. Remove hardcoded `remoteUser` from fallback config (defense-in-depth)

Change `writeDefaultDevcontainerConfig()` to omit `remoteUser` entirely, OR make it configurable via `DEFAULT_DEVCONTAINER_REMOTE_USER` env var:

```go
// If remoteUser is empty, omit it — let the image's default USER be used.
remoteUser := cfg.DefaultDevcontainerRemoteUser // from env var, default ""
if remoteUser != "" {
    // include "remoteUser": "<value>" in JSON
}
```

For `mcr.microsoft.com/devcontainers/base:ubuntu`, the Dockerfile already sets `USER vscode`, so the container will run as `vscode` regardless of whether `remoteUser` is in the config. Omitting it is safe and more resilient.

### 3. Update MEMORY.md (housekeeping)

The default image entry says `universal:2` but the code uses `base:ubuntu`. Fix the stale documentation.

## Checklist

- [x] Add `removeStaleContainers()` helper that finds containers by label in any state and removes them
- [x] Call `removeStaleContainers()` before `runDevcontainerWithDefault()` in the fallback path
- [x] Remove hardcoded `"remoteUser": "vscode"` from `writeDefaultDevcontainerConfig()`
- [x] Add `DEFAULT_DEVCONTAINER_REMOTE_USER` env var to `config.go` (default: empty string)
- [x] Only include `remoteUser` in generated JSON when explicitly configured
- [x] Update unit tests in `bootstrap_test.go` (config generation, no remoteUser by default)
- [x] Update integration test `TestIntegration_DevcontainerWithRemoteUser` to cover fallback-after-failure (fixed build error for 2-value return)
- [~] Add integration test: repo with bad devcontainer → fallback succeeds after cleanup (deferred — requires Docker-in-Docker in CI; verified via Playwright in prod instead)
- [x] Update MEMORY.md: correct default image from `universal:2` to `base:ubuntu`
- [x] Update `config.go` docs for new env var

## Files to Modify

- `packages/vm-agent/internal/bootstrap/bootstrap.go` — container cleanup + remoteUser fix
- `packages/vm-agent/internal/config/config.go` — new env var
- `packages/vm-agent/internal/bootstrap/bootstrap_test.go` — unit tests
- `packages/vm-agent/internal/bootstrap/bootstrap_integration_test.go` — integration tests
- `MEMORY.md` — fix stale default image reference

## Acceptance Criteria

1. When a repo's devcontainer config fails, the fallback succeeds by starting fresh (no stale container reuse)
2. The fallback works with any `DEFAULT_DEVCONTAINER_IMAGE`, not just Microsoft devcontainer images
3. `remoteUser` is only set when explicitly configured via env var
4. All existing tests pass, new tests cover the failure → cleanup → fallback path

## Verification

- **PR**: #58 (merged via squash)
- **CI**: All checks green (Lint, Type Check, Test, Build, VM Agent Test, VM Agent Integration, Preflight Evidence, UI Compliance, Validate Deploy Scripts, Pulumi Infrastructure Tests)
- **Deploy**: Successful (run 22006780033)
- **Playwright**: Created workspace with `serverspresentation2025/hono` on fresh node — workspace reached Running state with a working terminal. Previously this repo always failed with "unable to find user vscode". Screenshot: `.codex/tmp/playwright-screenshots/devcontainer-fallback-fix-verified.png`
- **Cleanup**: Test workspace and node deleted after verification.
