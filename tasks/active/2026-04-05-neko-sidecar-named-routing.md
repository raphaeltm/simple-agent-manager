# Named-Alias Sidecar Routing for Neko Browser

## Problem

The Neko browser sidecar uses port 8080 (default `NEKO_WEBRTC_PORT`) and is accessed via the same `ws-{id}--8080.{domain}` subdomain pattern as DevContainer ports. This creates two bugs:

1. **Port routing collision**: If the DevContainer also listens on 8080, the port proxy routes to the DevContainer (always resolves DevContainer bridge IP), making Neko unreachable.
2. **Socat self-bind failure**: The socat forwarder inside Neko tries to `TCP-LISTEN:8080` but Neko itself is already bound to 8080, causing "address already in use" failures.

## Solution

Introduce named sidecar aliases in the subdomain routing. Instead of `ws-{id}--8080`, Neko is accessed via `ws-{id}--browser`. This cleanly separates sidecar routing from numeric port routing:
- `ws-{id}--{number}` → always routes to DevContainer
- `ws-{id}--browser` → always routes to Neko sidecar

## Research Findings

### Key files:
- `apps/api/src/lib/workspace-subdomain.ts` — Parses `ws-{id}--{port}` subdomains. Currently rejects non-numeric suffixes as invalid ports.
- `apps/api/src/index.ts:560-580` — Routes port-specific requests to `/workspaces/{id}/ports/{port}` on VM agent.
- `packages/vm-agent/internal/server/ports_proxy.go` — Port proxy always resolves DevContainer bridge IP.
- `packages/vm-agent/internal/server/browser_handlers.go:228` — Constructs URL as `ws-{id}--{nekoPort}.{domain}`.
- `packages/vm-agent/internal/browser/socat.go:262` — `detectContainerPorts` has no exclusion for Neko's own port.
- `packages/vm-agent/internal/server/server.go:784-791` — Route registration for port proxy and browser handlers.

### Architecture:
- DNS wildcard + TLS wildcard already cover `ws-{id}--browser.{domain}` — no DNS/TLS changes needed.
- Neko container is on the same Docker network as DevContainer but has a separate bridge IP.
- The `BrowserManager` tracks per-workspace sidecar state including container name.
- The VM agent needs a new proxy endpoint to resolve the Neko container's bridge IP and forward traffic.

## Implementation Checklist

### 1. Shared types
- [ ] Add `SIDECAR_ALIASES` constant to `packages/shared/src/types/workspace.ts` (initially `['browser']`)

### 2. Subdomain parsing
- [ ] Extend `WorkspaceSubdomain` interface to add `sidecar: string | null`
- [ ] Update `parseWorkspaceSubdomain` to recognize non-numeric `--` suffixes as sidecar aliases
- [ ] Return error for unknown aliases (not in `SIDECAR_ALIASES`)
- [ ] Update tests for new sidecar alias parsing

### 3. API Worker routing
- [ ] In `apps/api/src/index.ts`, when `sidecar === 'browser'`, route to VM agent `/workspaces/{id}/browser/proxy{subPath}` instead of port proxy
- [ ] Same JWT token injection as port proxy

### 4. VM agent browser proxy endpoint
- [ ] Add `handleBrowserProxy` handler in `browser_handlers.go`
- [ ] Register route `/workspaces/{workspaceId}/browser/proxy/{path...}` in `server.go`
- [ ] Resolve Neko container's bridge IP via `BrowserManager.GetNekoBridgeIP(workspaceID)`
- [ ] Use `servePortProxy` or similar reverse proxy to forward to `http://{nekoIP}:{nekoPort}{path}`

### 5. VM agent BrowserManager
- [ ] Add `GetNekoBridgeIP(workspaceID string) (string, error)` method using `docker inspect`
- [ ] Update `browserStateToResponse` to construct URL as `ws-{id}--browser.{domain}` instead of `ws-{id}--{nekoPort}`

### 6. Socat port exclusion
- [ ] In `detectContainerPorts` or `syncForwarders`, filter out the Neko port (`m.cfg.NekoWebRTCPort`) from detected ports
- [ ] Add test for socat Neko port exclusion

### 7. Tests
- [ ] Unit tests for subdomain parsing with sidecar aliases
- [ ] Unit test for socat Neko port exclusion
- [ ] Integration/contract test verifying API Worker routes sidecar alias to browser proxy endpoint

## Acceptance Criteria

- [ ] `ws-{id}--browser.{domain}` routes to the Neko sidecar container (not DevContainer)
- [ ] `ws-{id}--8080.{domain}` still routes to DevContainer port 8080 (even when Neko is running)
- [ ] Socat does not attempt to forward the Neko port (no "address already in use" errors)
- [ ] `BrowserSidecarResponse.url` returns `ws-{id}--browser.{domain}` pattern
- [ ] All existing workspace port routing continues to work unchanged
- [ ] Unknown sidecar aliases return a clear error
