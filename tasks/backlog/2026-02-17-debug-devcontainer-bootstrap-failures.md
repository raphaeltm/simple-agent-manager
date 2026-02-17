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
- `git config user.name` is empty despite the bootstrap flow being wired to set it via `docker exec git config --system`
- The workspace is otherwise functional (terminal, ACP, file browser all work)
- No `sam-env.sh` in `/etc/profile.d/` (SAM env var injection was just added, so this is expected for pre-existing workspaces)

## Investigation Plan

- [ ] Check VM agent logs on the node hosting this workspace — look for `ensureGitIdentity` warning (just added), `devcontainer_up` step, and any fallback messages
- [ ] Check boot logs in the UI for this workspace — the reporter logs `devcontainer_up` status
- [ ] Determine if `hasDevcontainerConfig()` correctly detected the repo's `.devcontainer/devcontainer.json`
- [ ] Check if `--override-config` (mount override) conflicts with the repo's own features when the repo has a devcontainer config
- [ ] Verify the `postCreateCommand` (`bash .devcontainer/post-create.sh`) ran — check if Claude Code, pnpm, etc. are installed
- [ ] Test: create a fresh workspace from `simple-agent-manager` repo and observe the full boot log sequence
- [ ] If the issue is the fallback path: investigate why the repo's devcontainer config failed and whether the fallback silently drops features

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
