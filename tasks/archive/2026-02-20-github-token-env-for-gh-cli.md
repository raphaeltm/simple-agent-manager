# GitHub Token Environment Variable for gh CLI Support

**Created**: 2026-02-20
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Small

## Context

Workspaces already have a git credential helper (`git-credential-sam`) that fetches fresh GitHub App installation tokens for git operations (clone, push, pull). The default devcontainer config also already includes the `gh` CLI via the `ghcr.io/devcontainers/features/github-cli:1` devcontainer feature.

However, the `gh` CLI cannot be used for PR/issue operations because:

1. **No `GITHUB_TOKEN` env var** — `gh` CLI reads `GITHUB_TOKEN` from the environment. The token is only accessible through the git credential helper, which `gh` does not use.
2. **GitHub App permission scope** — The GitHub App may need `pull_requests: write` and `issues: write` permissions added. This is a settings change on the GitHub App itself, not a code change.

## Goal

Export `GITHUB_TOKEN` into the workspace environment during bootstrap so `gh` CLI works out of the box for PR creation, issue management, and other GitHub API operations.

## Approach (Simplest Version)

1. Modify `buildSAMEnvScript()` in `packages/vm-agent/internal/bootstrap/bootstrap.go` to accept an optional GitHub token and export it as `GITHUB_TOKEN`.
2. Pass the GitHub token from the bootstrap state through to `ensureSAMEnvironment()`.
3. The token is a GitHub App installation token with ~1 hour validity. For most workspace sessions this is sufficient.
4. Future improvement: create a refresh mechanism or wrapper script for long-running sessions.

## What Already Works

- Git credential helper (`git-credential-sam`) — refreshes tokens automatically for git operations
- `gh` CLI installed in default devcontainer via `ghcr.io/devcontainers/features/github-cli:1`
- Token generation via `getInstallationToken()` in the control plane
- SAM environment injection via `/etc/profile.d/sam-env.sh` and `/etc/sam/env`

## What Needs to Change

### Code Changes

| File | Change |
|------|--------|
| `packages/vm-agent/internal/bootstrap/bootstrap.go` | Modify `buildSAMEnvScript` to accept GitHub token; pass token from `Run()` and `PrepareWorkspace()` |

### GitHub App Settings (Manual, Not Code)

- Add `pull_requests: write` permission to the GitHub App
- Add `issues: write` permission to the GitHub App
- Existing users will need to approve the permission upgrade when prompted by GitHub

### Documentation

- Update `CLAUDE.md` / `AGENTS.md` with new env var mention in SAM environment section

## Future Enhancements

- Token refresh wrapper script for sessions longer than 1 hour
- `gh auth status` integration check during bootstrap
- Repos with their own devcontainer config may not have `gh` CLI — document that users can add the feature themselves

## Checklist

- [ ] Modify `buildSAMEnvScript` to accept and export `GITHUB_TOKEN`
- [ ] Pass GitHub token from bootstrap state to SAM environment setup
- [ ] Update existing `TestBuildSAMEnvScript` tests
- [ ] Add test for `GITHUB_TOKEN` inclusion/omission
- [ ] Update documentation (CLAUDE.md, AGENTS.md)
- [ ] CI green
