# Fix All Post-Merge Review Findings from PR #568

**Created**: 2026-03-31
**Source**: Post-merge specialist reviews of Neko Browser Streaming Sidecar (PR #568)
**Post-mortem**: `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md`

## Problem

PR #568 was merged before all specialist reviewers completed. Five backlog tasks were filed for CRITICAL/HIGH findings that should have been fixed pre-merge. This task addresses all five in a single PR.

## Research Findings

### Key Files
- **Go browser package**: `packages/vm-agent/internal/browser/` (manager.go, container.go, socat.go, docker.go, network.go)
- **Go HTTP handlers**: `packages/vm-agent/internal/server/browser_handlers.go`
- **Go auth**: `packages/vm-agent/internal/server/workspace_routing.go` (requireWorkspaceRequestAuth)
- **Go config**: `packages/vm-agent/internal/config/config.go`
- **API proxy routes**: `apps/api/src/routes/projects/browser.ts`, `apps/api/src/routes/workspaces/browser.ts`
- **React component**: `apps/web/src/components/BrowserSidecar.tsx`
- **React hook**: `apps/web/src/hooks/useBrowserSidecar.ts`
- **Cloud-init**: `packages/cloud-init/src/generate.ts`
- **Env interface**: `apps/api/src/index.ts`
- **Node provisioning**: `apps/api/src/services/nodes.ts`

### Patterns Observed
- Auth currently only supports cookie + `?token=` query param (no Bearer header)
- Mutex held across Docker CLI calls in manager.go and socat.go
- UI uses hand-rolled inline styles instead of design system components
- Cloud-init accepts nekoImage/nekoPrePull but API never passes them

## Implementation Checklist

### 1. Security Hardening (CRITICAL)

- [ ] Add `Authorization: Bearer` header support to `requireWorkspaceRequestAuth` in workspace_routing.go
- [ ] Move API proxy routes to send token via `Authorization: Bearer` header instead of `?token=` query param
- [ ] Generate cryptographically random password per Neko container (32-byte hex via `crypto/rand`), store in SidecarState
- [ ] Add Docker resource limits to container.go: `--memory` (NEKO_MEMORY_LIMIT, default 4g), `--cpus` (NEKO_CPU_LIMIT, default 2), `--pids-limit` (NEKO_PIDS_LIMIT, default 512)
- [ ] Add `--security-opt no-new-privileges` to container args
- [ ] Change `--restart unless-stopped` to `--restart no`
- [ ] Add configurable port range for socat (NEKO_SOCAT_MIN_PORT default 1024, NEKO_SOCAT_MAX_PORT default 65535)
- [ ] Add viewport bounds validation in handleStartBrowser (width 320-7680, height 240-4320, DPR 1-4)

### 2. Go Concurrency Fixes (CRITICAL)

- [ ] Refactor `syncForwarders` in socat.go: copy state under short read lock, do Docker I/O unlocked, re-acquire write lock to apply diff
- [ ] Refactor `Start` in manager.go: set StatusStarting under lock, release, run Docker unlocked, re-acquire for final status
- [ ] Add orphaned container recovery on Manager startup (docker ps --filter name=neko-)
- [ ] Add deferred cleanup in `Start` so container is removed if any step after docker run fails
- [ ] Fix `resolveContainerID` to return explicit error instead of ("", nil)
- [ ] Fix `removeForwarder` state consistency in syncForwarders (keep in remaining on failure)
- [ ] Add `/proc/net/tcp6` reading for IPv6 port detection
- [ ] Use `context.Background()` with timeout for browserManager.Stop() in workspace handlers

### 3. UI Polish (HIGH)

- [ ] Replace hand-rolled `<button>` elements with `Button` from `@simple-agent-manager/ui`
- [ ] Fix CSS variable names to match actual design tokens
- [ ] Replace bare `<div>` error display with `Alert` component
- [ ] Add ARIA attributes for accessibility (aria-hidden, aria-label, visually-hidden status text)
- [ ] Ensure 44px minimum touch targets on mobile

### 4. Cloud-Init Env Forwarding (MEDIUM)

- [ ] Add `NEKO_IMAGE` and `NEKO_PRE_PULL` to Env interface in apps/api/src/index.ts
- [ ] Forward both to `generateCloudInit()` in apps/api/src/services/nodes.ts
- [ ] Add to .env.example with documentation

### 5. Test Coverage (CRITICAL)

- [ ] Write Go tests for network discovery, handlers, and socat sync
- [ ] Write React tests for BrowserSidecar component and useBrowserSidecar hook
- [ ] Fix browser-proxy-contract.test.ts to exercise real route paths

## Acceptance Criteria

- All CRITICAL and HIGH security findings from the security auditor are fixed
- Mutex is never held across Docker I/O
- UI uses design system components consistently
- Cloud-init env vars are properly forwarded
- Tests cover all new and changed behavior
- All 5 backlog task files moved to tasks/archive/

## References

- tasks/backlog/2026-03-31-browser-sidecar-security-hardening.md
- tasks/backlog/2026-03-31-browser-sidecar-go-concurrency-fixes.md
- tasks/backlog/2026-03-31-browser-sidecar-test-coverage.md
- tasks/backlog/2026-03-31-browser-sidecar-ui-polish.md
- tasks/backlog/2026-03-31-neko-cloud-init-env-forwarding.md
