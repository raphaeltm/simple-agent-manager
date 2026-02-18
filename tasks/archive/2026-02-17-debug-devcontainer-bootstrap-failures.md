# Debug Devcontainer Bootstrap Failures

**Created**: 2026-02-17
**Priority**: high
**Source**: Observed in a live SAM workspace — Go feature not installed, git identity not configured

## Problem

A SAM-provisioned workspace running the `simple-agent-manager` repo (which has its own `.devcontainer/devcontainer.json`) exhibits two symptoms:

1. **Go is not installed** — the devcontainer feature `ghcr.io/devcontainers/features/go:1` did not apply
2. **Git identity is not configured** — `git config user.name` and `git config user.email` are both empty

These symptoms suggest the devcontainer either:
- Fell back to the default image (skipping the repo's devcontainer config entirely)
- Built successfully but features failed to install silently
- Hit the `postCreateCommand` failure path and was discarded in favor of a fallback container

## Evidence

- `which go` returns nothing; Go is not on PATH and not at `/usr/local/go/bin/`
- `which docker` returns nothing; Docker-in-Docker feature did not install
- `git config user.name` is empty despite the bootstrap flow being wired to set it via `docker exec git config --system`
- The workspace is otherwise functional (terminal, ACP, file browser all work)
- No `sam-env.sh` in `/etc/profile.d/` (SAM env var injection was just added, so this is expected for pre-existing workspaces)

### Confirmed: Running on fallback image

```
# /usr/local/etc/vscode-dev-containers/meta.env
DEFINITION_ID='base-ubuntu'    # ← fallback image, NOT typescript-node:24-bookworm
VARIANT='noble'
BUILD_TIMESTAMP='Fri, 30 Jan 2026 16:52:34 GMT'
```

The container is running `mcr.microsoft.com/devcontainers/base:ubuntu` (the `DefaultDevcontainerImage` in `config.go`), NOT `mcr.microsoft.com/devcontainers/typescript-node:24-bookworm` from the repo's `.devcontainer/devcontainer.json`.

This confirms the bootstrap fell back to the default image. Node.js is present because the default config injects `ghcr.io/devcontainers/features/node:1` via `AdditionalFeatures`, but Go, Docker-in-Docker, and GitHub CLI (repo-specific features) are all missing.

Running as `root` (not `vscode` or `node` as the repo's image would provide) is also consistent with the base:ubuntu fallback.

## Analysis: Fallback trigger path

The code in `ensureDevcontainerReady()` (bootstrap.go:460) follows this logic:

1. Clone repo to host at `cfg.WorkspaceDir` (host path)
2. `hasDevcontainerConfig(cfg.WorkspaceDir)` checks for `.devcontainer/devcontainer.json` on host → should be TRUE for this repo
3. If true: run `devcontainer up` with repo's config + volume mount override
4. If `devcontainer up` fails: log error, write `.devcontainer-build-error.log` to host workspace dir, remove stale containers, fall back to default image

**Key finding**: The `.devcontainer-build-error.log` is written to the host workspace dir (not the volume), so it's invisible from inside the container. To read it, SSH into the host VM or use the VM agent's file endpoints against the host filesystem.

The most likely failure cause for this specific repo: the `post-create.sh` script runs `curl -fsSL https://claude.ai/install.sh | bash` and `npm i -g @openai/codex` — if either fails (network timeout, rate limit, transient error), `set -e` aborts the whole postCreateCommand, and the devcontainer CLI reports an error code, triggering the fallback.

## Investigation Plan

- [ ] SSH to host VM or use VM agent API to read `.devcontainer-build-error.log` from the host workspace dir
- [ ] Check boot logs in the UI — the reporter logs `devcontainer_up` status; if it says "(fallback to default image)" the fallback is confirmed
- [ ] Check VM agent stdout logs on the node for the `"Devcontainer build failed with repo config, falling back to default image"` message
- [ ] If `postCreateCommand` is the culprit: consider making it fault-tolerant (remove `set -e`, or handle individual command failures gracefully)
- [ ] Consider: should devcontainer fallback preserve the already-built container when only lifecycle hooks fail? The features (Go, Docker, etc.) are already installed before postCreateCommand runs
- [ ] Test: create a fresh workspace from `simple-agent-manager` repo and observe the full boot log sequence

## Related

- `packages/vm-agent/internal/bootstrap/bootstrap.go` — `ensureDevcontainerReady()`, `hasDevcontainerConfig()`, fallback logic
- `packages/vm-agent/internal/bootstrap/bootstrap.go` — `ensureGitIdentity()` now logs when skipped (added in sam-workspace-env commit)
- `.devcontainer/devcontainer.json` — SAM's own devcontainer config with Go, Docker-in-Docker, GitHub CLI features
- `.devcontainer/post-create.sh` — post-create script installing Claude Code, pnpm, etc.

## Acceptance Criteria

- [ ] Root cause identified and documented
- [ ] Fix implemented so that SAM's own devcontainer features (Go, Docker-in-Docker, GitHub CLI) reliably install
- [ ] Git identity reliably configured in all workspace types
- [ ] SAM env vars (`/etc/profile.d/sam-env.sh`) present in newly created workspaces
