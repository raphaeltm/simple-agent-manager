# Browser Sidecar Test Coverage Gaps

**Created**: 2026-03-31
**Source**: Test engineer review of Neko Browser Streaming Sidecar (PR #568, completed post-merge)

## Problem

The browser sidecar has good coverage on pure helper functions (parseProcNetTCP, buildNekoEnv, buildDockerRunArgs) but significant gaps in integration paths, HTTP handlers, network discovery, and the entire web UI layer. The contract test uses static arrays instead of verifying against actual route registrations.

## Acceptance Criteria

### Critical — Zero coverage modules
- [ ] Write `network_test.go` for `DiscoverContainerNetwork` — custom network, bridge fallback, no networks, malformed JSON, docker inspect failure
- [ ] Write `browser_handlers_test.go` for all four HTTP handlers — auth rejection, browserManager nil guard, resolveContainerID fallback, browserStateToResponse URL construction, error status codes

### High — Core operational logic
- [ ] Write `socat_sync_test.go` covering `syncForwarders` and `SyncForwardersFromPorts` — add forwarder, remove forwarder, port appear/disappear across cycles, addForwarder failure handling, status != running early return
- [ ] Write `useBrowserSidecar.test.ts` — start in session mode vs workspace mode, polling start/stop, error preservation, cleanup on unmount
- [ ] Write `BrowserSidecar.test.tsx` — start button click, showViewer toggle, iframe render condition, stop button, error state with retry, per `.claude/rules/02-quality-gates.md` interactive element requirement
- [ ] Fix `browser-proxy-contract.test.ts` — replace static arrays with tests that exercise `proxyBrowserRequest` via mocked fetch, verify actual URL paths and headers constructed

### Medium — Route-level tests
- [ ] Add tests for `resolveSessionWorkspace` in `projects/browser.ts` — D1 lookup success, DO fallback, both fail, projectId mismatch, status check, no nodeId
- [ ] Add tests for workspace-level browser routes including DELETE status check consistency

### Low — Existing test improvements
- [ ] Parse YAML in cloud-init Neko tests instead of using `toContain` on raw strings
- [ ] Add `NEKO_PASSWORD_ADMIN` presence assertion to `container_test.go`

## References
- Network discovery: `packages/vm-agent/internal/browser/network.go`
- Handlers: `packages/vm-agent/internal/server/browser_handlers.go`
- Socat sync: `packages/vm-agent/internal/browser/socat.go`
- Hook: `apps/web/src/hooks/useBrowserSidecar.ts`
- Component: `apps/web/src/components/BrowserSidecar.tsx`
- Contract test: `apps/api/tests/unit/routes/browser-proxy-contract.test.ts`
- Project proxy: `apps/api/src/routes/projects/browser.ts`
