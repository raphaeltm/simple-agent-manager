# Workspace Port Exposure

**Created**: 2026-03-16
**Spec**: `specs/030-workspace-port-exposure/`
**Priority**: High — core UX feature for workspace usability

## Problem

When users run web applications inside workspace containers (Django, Vite, Flask, Express, etc.), they have no way to access those applications in their browser. The VM agent has a basic port proxy handler (`ports_proxy.go`) that forwards to `127.0.0.1:{port}`, but there is no port detection, no browser-accessible subdomain routing, and no UI to discover active ports.

Users need to be able to start a dev server and immediately access it via a URL like `https://ws-ABC123--3000.example.com/` without any manual configuration.

## Research Findings

Full research at `specs/030-workspace-port-exposure/research.md`. Key findings:

### What already exists (~70% of infrastructure)
- **Port proxy handler**: `packages/vm-agent/internal/server/ports_proxy.go` — reverse proxies to `127.0.0.1:{port}` with workspace auth
- **Event system**: `appendNodeEvent()` in `workspace_routing.go:462` — browser polls events every 10s
- **Container discovery**: `packages/vm-agent/internal/container/discovery.go` — resolves container IDs via Docker labels
- **Worker routing**: `apps/api/src/index.ts:329-412` — parses `ws-{id}` subdomains, proxies to VM agent
- **TLS**: Cloudflare edge wildcard cert covers `*.{domain}` — no new certs needed
- **Auth**: JWT + session cookies via `requireWorkspaceRequestAuth()` — production-ready
- **UI sidebar**: `WorkspaceSidebar.tsx` with `CollapsibleSection` pattern

### What must be built
1. **Port scanner** (Go) — parse `/proc/net/tcp` inside containers via `docker exec`
2. **Port list endpoint** — `GET /workspaces/{id}/ports` on VM agent
3. **Port events** — `port.detected` / `port.closed` via existing event system
4. **Worker subdomain parsing** — parse `ws-{id}--{port}` pattern in CF Worker
5. **Proxy target fix** — use container bridge IP (from `docker inspect`) instead of `127.0.0.1`
6. **UI: Active Ports** — new `CollapsibleSection` in `WorkspaceSidebar` + ProjectChat
7. **Cookie domain** — set session cookie with `Domain=.{domain}` for subdomain sharing

### Key design decisions
- **Subdomain pattern**: `ws-{id}--{port}.{domain}` (double-dash separator)
- **Detection**: Poll `/proc/net/tcp` every 5s (configurable)
- **Filtering**: Exclude ports 22, 2375, 2376, 8443, and ephemeral range (>= 32768)
- **Storage**: All in-memory on VM agent; no DB schema changes
- **Auth**: Reuse existing workspace JWT + session cookie

## Implementation Checklist

### Phase 1: Detection + API (VM Agent, Go)
- [ ] Create `/proc/net/tcp` parser in `packages/vm-agent/internal/ports/` (new package)
- [ ] Implement port scanner goroutine that runs per-workspace at configurable interval
- [ ] Add container bridge IP resolution via `docker inspect` (extend `container/discovery.go`)
- [ ] Cache bridge IP with configurable TTL (`PORT_PROXY_CACHE_TTL_MS`)
- [ ] Create `GET /workspaces/{workspaceId}/ports` endpoint on VM agent
- [ ] Emit `port.detected` / `port.closed` events via `appendNodeEvent()`
- [ ] Update `ports_proxy.go` to proxy to container bridge IP instead of `127.0.0.1`
- [ ] Add configuration variables: `PORT_SCAN_INTERVAL_MS`, `PORT_SCAN_EXCLUDE`, `PORT_SCAN_EPHEMERAL_MIN`, `PORT_PROXY_CACHE_TTL_MS`, `PORT_SCAN_ENABLED`
- [ ] Write unit tests for `/proc/net/tcp` parser (realistic multi-line data)
- [ ] Write integration test for port scanning with mock container

### Phase 2: Worker Routing (API, TypeScript)
- [ ] Parse `ws-{id}--{port}` subdomain pattern in `apps/api/src/index.ts`
- [ ] Route port requests to VM agent port proxy endpoint (`/workspaces/{id}/ports/{port}`)
- [ ] Validate port range (1-65535) in Worker before forwarding
- [ ] Ensure session cookies use `Domain=.{domain}` for subdomain sharing
- [ ] Write unit tests for subdomain parsing (with and without port suffix)
- [ ] Write integration test for end-to-end proxy routing

### Phase 3: UI Integration (Web, TypeScript/React)
- [ ] Add `DetectedPort` type to `packages/shared/src/types.ts`
- [ ] Create port fetching hook (`useWorkspacePorts`) in web app
- [ ] Add "Active Ports" `CollapsibleSection` to `WorkspaceSidebar.tsx`
- [ ] Add port indicators to ProjectChat workspace context
- [ ] Each port row: port number, label, clickable link (opens new tab)
- [ ] Construct URLs as `https://ws-{id}--{port}.{BASE_DOMAIN}`
- [ ] Handle empty state ("No active ports detected")
- [ ] Write behavioral tests for port section rendering and link clicks

### Phase 4: Polish
- [ ] Add port label heuristics (common port → human name mapping)
- [ ] Add "(local)" indicator for `127.0.0.1`-only bindings
- [ ] Read `devcontainer.json` `portsAttributes` for label overrides (best-effort)
- [ ] Capability test: start HTTP server in container → verify port appears in API → verify URL accessible

## Acceptance Criteria

- [ ] User starts `python -m http.server 8000` in workspace terminal → port appears in sidebar within 10 seconds
- [ ] Clicking port link opens the served content at `https://ws-{id}--8000.{domain}` in new tab
- [ ] Infrastructure ports (SSH, Docker, VM agent) never appear in port list
- [ ] Two workspaces on same node can both run port 3000 without conflict (bridge IP isolation)
- [ ] Unauthenticated requests to port URLs are rejected (401)
- [ ] Port scanning adds < 5ms overhead per scan cycle per workspace
- [ ] All configuration values overridable via environment variables
- [ ] Active ports visible in both workspace sidebar and project chat view

## References

- Spec: `specs/030-workspace-port-exposure/spec.md`
- Data model: `specs/030-workspace-port-exposure/data-model.md`
- Research: `specs/030-workspace-port-exposure/research.md`
- Existing port proxy: `packages/vm-agent/internal/server/ports_proxy.go`
- Existing event system: `packages/vm-agent/internal/server/workspace_routing.go:462`
- Existing Worker routing: `apps/api/src/index.ts:329-412`
- Existing sidebar: `apps/web/src/components/WorkspaceSidebar.tsx`
