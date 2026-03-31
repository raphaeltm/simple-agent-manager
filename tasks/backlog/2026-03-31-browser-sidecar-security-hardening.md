# Browser Sidecar Security Hardening

**Created**: 2026-03-31
**Source**: Security auditor review of Neko Browser Streaming Sidecar (PR #568, completed post-merge)

## Problem

The browser sidecar has several security gaps: JWT tokens passed as URL query parameters (logged in plaintext), shared Neko credentials across all containers (defense-in-depth failure), no Docker resource limits (DoS risk in multi-tenant), and well-known ports exposed via socat forwarding.

## Acceptance Criteria

### Critical — JWT query parameter exposure
- [ ] Move JWT terminal token from `?token=` query parameter to `Authorization: Bearer` header in both `apps/api/src/routes/projects/browser.ts` and `apps/api/src/routes/workspaces/browser.ts`
- [ ] Add `Authorization` header support to `requireWorkspaceRequestAuth` in `packages/vm-agent/internal/server/workspace_routing.go` (currently only checks cookie and `?token=` query param)
- [ ] Deprecate the `?token=` query parameter path

### High — Per-container random credentials
- [ ] Generate cryptographically random password per Neko container at start time (32-byte hex via `crypto/rand`)
- [ ] Store password in `SidecarState` so the proxy can inject it when forwarding
- [ ] Remove reliance on shared `NEKO_PASSWORD`/`NEKO_PASSWORD_ADMIN` env vars for container auth (env vars remain as fallback defaults only)

### High — Docker resource limits
- [ ] Add `--memory` limit to Neko container (configurable via `NEKO_MEMORY_LIMIT`, default e.g. `4g`)
- [ ] Add `--cpus` limit (configurable via `NEKO_CPU_LIMIT`, default e.g. `2`)
- [ ] Add `--pids-limit` (configurable via `NEKO_PIDS_LIMIT`, default e.g. `512`)
- [ ] Add `--security-opt no-new-privileges`
- [ ] Change `--restart unless-stopped` to `--restart no` (Manager controls lifecycle)

### Medium — Port range restriction
- [ ] Exclude well-known ports (1-1023) from socat forwarding in `parseProcNetTCP`
- [ ] Make allowed port range configurable via `NEKO_SOCAT_MIN_PORT` / `NEKO_SOCAT_MAX_PORT`

### Low — Viewport bounds validation
- [ ] Add bounds validation for `ViewportWidth` (320-7680) and `ViewportHeight` (240-4320) in `handleStartBrowser`
- [ ] Add bounds validation for `DevicePixelRatio` (1-4)
- [ ] Return HTTP 400 for out-of-range values

## References
- Proxy routes: `apps/api/src/routes/projects/browser.ts`, `apps/api/src/routes/workspaces/browser.ts`
- VM agent auth: `packages/vm-agent/internal/server/workspace_routing.go`
- Container setup: `packages/vm-agent/internal/browser/container.go`
- Port scanning: `packages/vm-agent/internal/browser/socat.go`
- Handlers: `packages/vm-agent/internal/server/browser_handlers.go`
