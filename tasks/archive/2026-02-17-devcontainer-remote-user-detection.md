# Devcontainer Remote User Detection

**Created**: 2026-02-17
**Priority**: High
**Type**: Bug fix

## Problem

Terminal sessions (PTY), agent processes (Claude Code), and all `docker exec` operations in SAM workspaces run as `root` instead of the devcontainer's intended `remoteUser`.

### Root Cause

SAM's VM agent calls raw `docker exec` (without `-u`) to create PTY sessions, run agent processes, and perform file/git operations. When `CONTAINER_USER` is not set (the default), `docker exec` inherits the **container's Dockerfile `USER`** — which is `root` for virtually all devcontainer base images.

The devcontainer spec defines `remoteUser` as a **tooling-level** concept: it tells development tools (VS Code, `devcontainer exec`) which user to run processes as. It is NOT a Docker container property — raw `docker exec` knows nothing about it.

VS Code correctly resolves `remoteUser` from:
1. The `remoteUser` field in `devcontainer.json`
2. The image's embedded devcontainer metadata labels (`devcontainer-metadata`)

SAM uses `devcontainer up` to build/start the container (which resolves `remoteUser` internally), but then **bypasses the devcontainer CLI entirely** for all runtime operations, using raw `docker exec` instead. The resolved `remoteUser` is never queried or passed through.

This is NOT specific to recovery containers — it affects all workspaces, both fresh provisioning and recovery. The recovery path simply makes it more visible because `ensureDevcontainerReady` short-circuits when the container is already running, but the bug exists regardless: even on first boot, once `devcontainer up` finishes, all subsequent `docker exec` calls run as `root`.

### Observed Behavior

- **SAM**: `whoami` in terminal returns `root` (uid=0)
- **VS Code**: Same repo, same devcontainer.json, same image → terminal runs as `vscode` or `node`

### Affected Operations

All `docker exec` calls in the VM agent when `CONTAINER_USER` is empty:

| Operation | File | Impact |
|-----------|------|--------|
| PTY terminal sessions | `internal/pty/session.go:110-123` | User sees `root@` prompt, files created as root |
| Agent processes (Claude Code) | `internal/acp/process.go:49-55` | Agent runs as root, creates files as root |
| Git status/diff/file read | `internal/server/git.go` | Reads work, but permission mismatch possible |
| File browser/find | `internal/server/files.go` | Reads work, but shows root ownership |
| ACP ReadTextFile/WriteTextFile | `internal/acp/session_host.go` | Writes files as root inside container |

Note: Some operations intentionally use `-u root` (agent binary installation, git credential helper install, system-level git config). These are correct and should not change.

### Why This Matters

1. **File ownership mismatch**: Files created by root-running terminals/agents are owned by `root:root`, but the devcontainer's intended user (e.g., `vscode` uid 1000) may not have write access to them later
2. **Permission errors**: Some devcontainer setups (e.g., `postCreateCommand` scripts) configure directories for the non-root user; root-created files break assumptions
3. **Behavioral parity**: Users expect SAM terminals to behave like VS Code terminals for the same devcontainer config
4. **Security**: Running as root inside the container is unnecessarily privileged

## Proposed Solution

### Approach: Detect remoteUser After `devcontainer up`

After `devcontainer up` completes, query the devcontainer CLI for the resolved `remoteUser` and pass it through as `ContainerUser` for all subsequent `docker exec` calls.

### Implementation Steps

- [x] **Detect resolved remoteUser** after `devcontainer up` completes
  - **Option A (recommended)**: Run `devcontainer read-configuration --workspace-folder <dir>` which outputs JSON including the fully merged `remoteUser` value (resolves image metadata labels, devcontainer.json, and defaults)
  - Option B: Inspect the container's `devcontainer-metadata` Docker label and parse `remoteUser` from the merged metadata array
  - Option C: Fallback — run `devcontainer exec --workspace-folder <dir> whoami` which automatically runs as `remoteUser`
  - The detection should happen in `ensureDevcontainerReady()` after successful `devcontainer up`, and return the detected user alongside the `usedFallback` bool

- [x] **Store detected user in workspace state** so it persists across VM agent restarts
  - Add a `containerUser` field to the workspace runtime state in the persistence DB (`state.db`)
  - Populate after successful bootstrap
  - Load on workspace recovery/reattach so the recovery path also gets the correct user

- [x] **Wire detected user through to all `docker exec` callers**
  - `pty.ManagerConfig.ContainerUser` — terminal sessions
  - `acp.GatewayConfig.ContainerUser` — agent processes
  - `server.Config.ContainerUser` — git/file operations
  - Currently these all read from `cfg.ContainerUser` (set in `server.go:118-129`) which comes from `CONTAINER_USER` env var; the detected value should be used when the env var is empty
  - The per-workspace PTY manager rebuild in `rebuildWorkspacePTYManager()` must also carry the detected user

- [x] **Preserve `CONTAINER_USER` env var as manual override**
  - If `CONTAINER_USER` is explicitly set, it takes precedence over detection
  - If empty (default), use the detected value from `devcontainer read-configuration`

- [x] **Add logging** for user detection
  - Log the detected `remoteUser` after bootstrap
  - Log when `CONTAINER_USER` override is active
  - Warn if detected user is `root` (unexpected for most devcontainer images)

- [x] **Handle edge cases**
  - Repos with no devcontainer.json (SAM's default config) — detection should still work after `devcontainer up` since the image metadata provides `remoteUser`
  - Repos where `remoteUser` is intentionally `root` — respect it, just log
  - Fallback if `devcontainer read-configuration` is unavailable — try `devcontainer exec whoami` or parse Docker labels

- [x] **Add tests**
  - Unit test: parsing `read-configuration` JSON output to extract `remoteUser`
  - Integration test: bootstrap with `remoteUser: "vscode"` → verify `ContainerUser` is `vscode`
  - Integration test: bootstrap without explicit `remoteUser` but image default is non-root → verify detection works
  - Integration test: `CONTAINER_USER` env var overrides detected value

## Key Insight: `docker exec` vs `devcontainer exec`

The fundamental issue is that SAM uses `docker exec` where it should either:
1. Use `devcontainer exec` (which respects `remoteUser` automatically), or
2. Detect `remoteUser` and pass `-u <user>` to `docker exec`

Option 2 is preferred because `devcontainer exec` has higher overhead (CLI startup, config resolution on every call) and SAM already has the container ID cached. The detection only needs to happen once after `devcontainer up`.

## References

- Devcontainer spec: `remoteUser` "Defaults to the user the container as a whole is running as (often `root`)" — the spec clarifies this is a tooling concept, not a Docker concept
- Container user flow: `config.go:239-241` → `server.go:118-129` → `pty/session.go:110-123`
- Bootstrap: `bootstrap.go:460+` (`ensureDevcontainerReady`)
- Recovery path: `workspace_provisioning.go:88+` (`recoverWorkspaceRuntime`) → calls `PrepareWorkspace` → `ensureDevcontainerReady` short-circuits when container exists
- This repo's `.devcontainer/devcontainer.json` has no `remoteUser`; image `mcr.microsoft.com/devcontainers/typescript-node:24-bookworm` has Dockerfile `USER root` but embeds `remoteUser` in image metadata labels

## Preflight Evidence (2026-02-19)

### Change Classes

- `external-api-change`
- `cross-component-change`
- `business-logic-change`
- `public-surface-change`
- `docs-sync-change`

### External Research Notes

- `containers.dev` reference confirms `remoteUser` defaults to container runtime user if unspecified and is distinct from `containerUser`.
- `containers.dev` lifecycle docs define `postCreateCommand` as running after the container has started and "been assigned to a user for the first time".
- Docker CLI docs confirm `docker exec` runs as default container user unless `--user/-u` is provided.
- Verified against current `@devcontainers/cli` (`0.83.2`):
  - `read-configuration --include-merged-configuration` returns resolved `mergedConfiguration.remoteUser`.
  - `up` returns JSON with `remoteUser` and running container metadata labels include remote-user data.

### Implementation Checklist (Execution)

- [x] Move task from backlog to active and finalize preflight evidence
- [x] Detect and persist effective workspace container user during bootstrap/recovery
- [x] Propagate workspace-scoped `ContainerUser` to PTY, ACP, git/file/worktree paths
- [x] Preserve `CONTAINER_USER` override precedence and add diagnostics logging
- [x] Add/update unit tests for detection + propagation
- [x] Update documentation (including `AGENTS.md` + `CLAUDE.md` sync)
- [x] Run impacted test suites and confirm green
- [ ] Open PR with preflight evidence, wait for CI green, merge
