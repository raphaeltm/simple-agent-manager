# Devcontainer Network Resilience: Apt Mirrors + Build Timeout

**Created**: 2026-05-05
**Priority**: CRITICAL
**Related**: `tasks/backlog/2026-05-05-debug-package-fixes.md` (Issues 1-3)

## Problem Statement

Workspaces fail to become ready when `archive.ubuntu.com` is slow/unreachable during devcontainer builds. On 2026-05-05, Ubuntu/Canonical experienced a DDoS/outage that caused all workspace provisioning to fail with 30-minute timeouts. The root causes:

1. **Containers use `archive.ubuntu.com` instead of the provider's fast local mirror** — host VMs on Hetzner use `mirror.hetzner.com` (fast), but Docker containers default to `archive.ubuntu.com` which is slow/unreachable through Docker bridge NAT on Hetzner.

2. **No devcontainer build timeout** — `devcontainer up` inherits the parent context with no explicit deadline. When apt hangs, the build blocks for 30 minutes until the workspace-ready timeout kills it.

3. **No apt retry configuration** — neither host nor container uses `Acquire::Retries` for transient network failures.

## Research Findings

### Key Files
- `packages/cloud-init/src/generate.ts` — `CloudInitVariables` interface, no `provider` field
- `packages/cloud-init/src/template.ts` — cloud-init template, no apt mirror config for containers
- `apps/api/src/services/nodes.ts:150-167` — `generateCloudInit()` call, `targetProvider` available but not passed
- `packages/vm-agent/internal/bootstrap/bootstrap.go:860` — `exec.CommandContext(ctx, "devcontainer", args...)` with no timeout
- `packages/vm-agent/internal/config/config.go` — Config struct, no `DevcontainerBuildTimeout` field
- `packages/shared/src/constants/task-execution.ts` — `DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS = 30min`

### Provider-Specific Mirrors
- Hetzner: `mirror.hetzner.com` (already used by host OS)
- Scaleway/GCP: defaults fine (good peering to Ubuntu mirrors)

### User Preference (from knowledge graph)
User wants lightweight containers to support Docker usage with fast boot via privileged mode. Docker install on-demand preferred over pre-installing during devcontainer build (fragile to apt network failures).

## Implementation Checklist

### 1. Thread provider through cloud-init
- [ ] Add `provider` field to `CloudInitVariables` interface in `generate.ts`
- [ ] Add validation for provider field (must be `hetzner`, `scaleway`, or `gcp`)
- [ ] Pass `targetProvider` from `nodes.ts` to `generateCloudInit()`
- [ ] Add `PROVIDER` environment variable to vm-agent systemd service in cloud-init template
- [ ] Update cloud-init tests

### 2. Inject apt mirror config into containers
- [ ] Add provider-aware apt mirror script as a `write_files` entry in cloud-init template
- [ ] VM agent reads `PROVIDER` env var from config
- [ ] Add `Provider` field to vm-agent Config struct
- [ ] In bootstrap, inject `/etc/apt/sources.list.d/provider-mirror.list` into containers before package installs (via docker exec or devcontainer mount)
- [ ] Only apply Hetzner mirror on Hetzner provider

### 3. Add devcontainer build timeout
- [ ] Add `DevcontainerBuildTimeout` field to vm-agent Config struct (default: 15min)
- [ ] Add `DEVCONTAINER_BUILD_TIMEOUT` env var support in config loading
- [ ] Wrap `devcontainer up` calls in `ensureDevcontainerReady()` with timeout context
- [ ] Log timeout error with diagnostics (which step hung, elapsed time)
- [ ] Add test for timeout behavior

### 4. Add apt retry configuration
- [ ] Write `/etc/apt/apt.conf.d/80-retries` with `Acquire::Retries "3";` in cloud-init (for host)
- [ ] Include retry config in container apt mirror injection

### 5. Tests
- [ ] Unit test: cloud-init generates correct provider env var
- [ ] Unit test: apt mirror script only applies for Hetzner
- [ ] Unit test: devcontainer build timeout is respected
- [ ] Integration test: generated YAML parses correctly with new fields

## Acceptance Criteria

- [ ] Containers on Hetzner VMs use `mirror.hetzner.com` for apt operations
- [ ] Containers on non-Hetzner providers use default Ubuntu mirrors
- [ ] `devcontainer up` has a configurable timeout (default 15min, via `DEVCONTAINER_BUILD_TIMEOUT`)
- [ ] Apt operations retry up to 3 times on transient failures
- [ ] Provider abstraction respected (no Hetzner-specific assumptions for other providers)
- [ ] All changes have tests
- [ ] Cloud-init template passes YAML parse validation in tests

## References

- Failed task: `01KQVADC1ZF9ESQH70KWJDY7FB` (workspace timeout after apt failures)
- Debug package analysis: `tasks/backlog/2026-05-05-debug-package-fixes.md`
- Cloud-init template: `packages/cloud-init/src/template.ts`
- VM agent bootstrap: `packages/vm-agent/internal/bootstrap/bootstrap.go`
- Node provisioning: `apps/api/src/services/nodes.ts`
