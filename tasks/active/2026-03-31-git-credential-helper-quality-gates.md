# Git Credential Helper — Quality Gates Completion

**Created**: 2026-03-31
**PR**: #573 (`sam/implement-git-credential-helper-01kn1x`)
**Idea**: 01KN1X043A7P2Y1PYW5MFGJNAW
**Original Task**: 01KN1X0RXVMT2XKSKB0WGBTRVS

## Problem

PR #573 implements git credential helper availability during devcontainer lifecycle hooks. The code was written and tests added, but the implementing agent skipped the `/do` workflow — no specialist reviews, no staging verification, no task-completion-validator, no preflight evidence.

## What Was Implemented

- `writeCredentialHelperToHost()` — pre-generates credential helper script on VM host before `devcontainer up`
- Bind-mount + `GIT_CONFIG_*` containerEnv injection into all 4 devcontainer-up paths
- `RemoveCredentialHelperFromHost()` — cleanup on workspace deletion
- `writeCredentialOverrideConfig()` — minimal override for repos with config but no volume
- `injectCredentialHelperIntoConfig()` — non-clobbering merge into existing devcontainer config
- 10 new unit tests, integration test signature updates

## Acceptance Criteria

- [x] All 4 devcontainer-up paths carry credential helper mount + env
- [x] Existing `ensureGitCredentialHelper()` kept as belt-and-suspenders fallback
- [x] Host-side cleanup on workspace deletion
- [x] Non-fatal errors — credential helper failure doesn't block provisioning
- [x] Read-only bind mount into container
- [x] Unit tests pass for all new functions
- [ ] go-specialist review passes (no CRITICAL/HIGH findings)
- [ ] security-auditor review passes (no CRITICAL/HIGH findings)
- [ ] task-completion-validator passes
- [ ] Staging deployment green
- [ ] Infrastructure verification — workspace provisioned and credential helper works
- [ ] PR #573 updated with preflight evidence and review table

## Implementation Checklist

- [x] Review existing code changes on branch
- [x] Verify all Go unit tests pass
- [ ] Run preflight classification
- [ ] Dispatch go-specialist review
- [ ] Dispatch security-auditor review
- [ ] Address all CRITICAL/HIGH findings
- [ ] Run task-completion-validator
- [ ] Deploy to staging
- [ ] Provision workspace and verify credential helper
- [ ] Update PR description with quality gate evidence

## Preflight Classification

- `security-sensitive-change` — credential handling, file permissions, bind-mount security
- `cross-component-change` — bootstrap → server (workspace deletion cleanup)
- Go code in `packages/vm-agent/`

## Research Findings

1. **File size**: `bootstrap.go` is 2408 lines (was 2232 on main). Pre-existing violation of 800-line rule — not introduced by this PR.
2. **Credential helper writes to /tmp**: Uses `/tmp/git-credential-sam-{workspaceID}` — world-readable /tmp but file permissions are 0755 (executable). Script contains callback token and port. Other processes on the host could read the token.
3. **No GIT_CONFIG_COUNT collision check**: If the devcontainer config already sets `GIT_CONFIG_COUNT`, the injected values will clobber it. Edge case — unlikely in practice.
4. **Credential helper script content**: Contains the callback token embedded in the script. This is the same pattern used by the existing `renderGitCredentialHelperScript()` function.
