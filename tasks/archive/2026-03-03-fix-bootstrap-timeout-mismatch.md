# Fix Bootstrap Timeout Mismatch

**Created**: 2026-03-03
**Type**: Bug fix
**Priority**: High

## Problem

Tasks fail with: `Task failed: failed to locate devcontainer for credential helper setup: docker ps failed: context deadline exceeded`

## Root Cause

The VM Agent's `BOOTSTRAP_TIMEOUT` defaults to **15 minutes** (`packages/vm-agent/internal/config/config.go:209`), but the API-side workspace ready timeout was recently increased to **30 minutes** (`packages/shared/src/constants.ts:178`, commit `cd22f26`). Projects with non-trivial devcontainer builds (custom Dockerfiles, large dependency trees) easily exceed 15 minutes, causing the shared bootstrap context to expire. When this happens, any subsequent `docker ps` or `docker exec` call fails with `context deadline exceeded`.

The error occurs at `bootstrap.go:1466` during the `ensureGitCredentialHelper` step, which is the 6th sequential step in bootstrap — meaning the devcontainer build succeeded but consumed nearly all of the 15-minute budget.

## Research Findings

- **Error origin**: `packages/vm-agent/internal/bootstrap/bootstrap.go:1637-1642` — `findDevcontainerID()` calls `exec.CommandContext(ctx, "docker", "ps", ...)` using the shared bootstrap context
- **Context creation**: `packages/vm-agent/main.go:64` — `context.WithTimeout(context.Background(), cfg.BootstrapTimeout)`
- **Default timeout**: `packages/vm-agent/internal/config/config.go:209` — `getEnvDuration("BOOTSTRAP_TIMEOUT", 15*time.Minute)`
- **API timeout**: `packages/shared/src/constants.ts:178` — `DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS = 30 * 60 * 1000`
- **All bootstrap steps share the same context**: clone, devcontainer build, gh CLI install, git creds, git identity, SAM env — sequential with no per-step timeouts

## Fix

- [x] Increase VM Agent `BOOTSTRAP_TIMEOUT` default from 15 to 30 minutes in `config.go`
- [x] Add comment noting alignment with API-side timeout

## Acceptance Criteria

- [x] VM Agent bootstrap timeout matches API-side workspace ready timeout (30 minutes)
- [x] `BOOTSTRAP_TIMEOUT` env var still allows override for custom deployments
- [x] No other code changes needed — the env var override mechanism already works
