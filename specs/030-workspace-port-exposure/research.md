# Research: Workspace Port Exposure

**Created**: 2026-03-16
**Status**: Complete
**Goal**: Allow logged-in users to automatically access ports exposed by applications running inside workspace containers (e.g., Django dev server, Vite, Flask) via the browser.

## Summary

This research evaluates how to detect listening ports inside workspace containers and expose them to authenticated users via browser-accessible URLs. The existing infrastructure already provides ~70% of the plumbing: the VM agent has a port proxy handler, TLS terminates at Cloudflare edge, and workspace auth (JWT + session cookies) is production-ready. The main gaps are port detection, Worker-side subdomain routing, and UI integration.

---

## R1: Port Detection Strategy

**Decision**: Poll `/proc/net/tcp` inside the container via `docker exec` every 5 seconds (configurable via `PORT_SCAN_INTERVAL_MS`).

**Rationale**: `/proc/net/tcp` is the canonical Linux interface for enumerating listening sockets. Each line contains a local address (hex-encoded IP:port) and socket state. State `0x0A` = `LISTEN`. This catches any process that binds a port — `npm run dev`, `python manage.py runserver`, `cargo run`, etc. — with zero configuration from the user.

**Format** (from `/proc/net/tcp`):
```
  sl  local_address rem_address   st ...
   0: 00000000:0BB8 00000000:0000 0A ...  ← port 0x0BB8 = 3000, LISTEN on 0.0.0.0
   1: 0100007F:1F90 00000000:0000 0A ...  ← port 0x1F90 = 8080, LISTEN on 127.0.0.1
```

**Performance**: Reading `/proc/net/tcp` via `docker exec` costs ~1-3ms per invocation. At a 5-second interval, this is negligible. The VM agent already does periodic `docker exec` calls for system info collection (`sysinfo.go:Collect()`) and `docker ps` for container discovery (`discovery.go`), so this fits established patterns.

**Alternatives considered**:
- **inotify on /proc/net/tcp** — rejected; procfs doesn't support inotify
- **eBPF `sock:inet_sock_set_state` tracepoint** — rejected; too complex, requires kernel headers and privileged access, overkill for dev environments
- **Polling `ss -tlnp` via docker exec** — viable but parses human-readable output; `/proc/net/tcp` is more stable and machine-parseable
- **Netlink socket monitoring** — rejected; requires raw socket privileges inside the container
- **Container-side sidecar process** — rejected; adds complexity to devcontainer setup, user would need to configure it

## R2: Port Filtering — What NOT to Show

**Decision**: Filter out infrastructure ports and ephemeral range ports. Make the exclusion list configurable.

**Default exclusions** (`PORT_SCAN_EXCLUDE`, comma-separated):
| Port | Service | Why exclude |
|------|---------|-------------|
| 22 | SSH (sshd) | Infrastructure; user doesn't interact with it directly |
| 2375, 2376 | Docker daemon | Infrastructure |
| 8443 | VM agent | Infrastructure; already exposed as the workspace URL |

**Ephemeral range** (`PORT_SCAN_EPHEMERAL_MIN`, default: 32768): Ports >= 32768 are typically ephemeral client-side ports (outbound connections), not user-started servers. Exclude by default.

**Binding address distinction**:
- `0.0.0.0` (all interfaces) — user-started server, show prominently
- `127.0.0.1` (loopback only) — local-only service, show with "(local)" indicator or de-emphasize
- This distinction is available from the `local_address` field in `/proc/net/tcp`

**Alternatives considered**:
- Show all ports unconditionally — rejected; noisy, shows sshd/docker/agent ports that confuse users
- Only show ports declared in `devcontainer.json` `forwardPorts` — rejected; requires user configuration, defeats "automatic" detection
- Combine both: auto-detect + `devcontainer.json` labels — viable as an enhancement but not required for v1

## R3: Proxy Target — Container Bridge IP vs. Localhost

**Decision**: Proxy to the container's bridge network IP (obtained via `docker inspect`), not `127.0.0.1` on the host.

**Rationale**: The current `ports_proxy.go` proxies to `http://127.0.0.1:{port}`. This works ONLY when a single container publishes ports to the host via `-p`. For multi-workspace nodes (multiple containers on one VM), a port on container A's `127.0.0.1:3000` is NOT reachable from the host's `127.0.0.1:3000` unless explicitly published. Using the container's bridge IP (`172.17.0.x`) guarantees the proxy reaches the correct container regardless of port publishing.

**How to get the bridge IP**:
```bash
docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <container_id>
```

The VM agent already resolves container IDs via `container/discovery.go` — this extends that to also cache the bridge IP.

**Cache TTL**: `PORT_PROXY_CACHE_TTL_MS` (default: 30000). Container IPs rarely change during a session. Cache to avoid repeated `docker inspect` calls.

**Alternatives considered**:
- Use `docker port` mapping — rejected; requires `-p` flag on container start, which devcontainers don't always do
- Use host networking (`--network host`) — rejected; breaks container isolation and conflicts when multiple workspaces are on the same node
- Keep `127.0.0.1` and require port publishing — rejected; doesn't work for multi-workspace nodes

## R4: Subdomain Routing Pattern

**Decision**: Use `ws-{id}--{port}.{domain}` pattern with double-dash (`--`) separator.

**Why double-dash**: Single dash is already used in workspace IDs (`ws-ABC123`). Double-dash is unambiguous and used by other platforms (e.g., Gitpod uses `{port}-{workspace}.ws.{domain}`). The Worker can split on `--` to extract the port suffix.

**Worker routing flow** (extends `apps/api/src/index.ts:329-412`):
```
Request: https://ws-ABC123--3000.example.com/
  1. Extract hostname: "ws-ABC123--3000.example.com"
  2. Parse subdomain: "ws-ABC123--3000"
  3. Split on "--": workspaceSubdomain = "ws-ABC123", port = "3000"
  4. Extract workspace ID: "ABC123"
  5. Look up workspace in D1 (existing flow)
  6. Build backend URL: https://{nodeId}.vm.{domain}:8443/workspaces/{id}/ports/3000
  7. Forward request with auth headers (existing flow)
```

**DNS**: No new DNS records needed. The existing `ws-{id}` A record is proxied (orange-clouded) through Cloudflare, which means `ws-{id}--3000` resolves via the wildcard Worker route (`*.{domain}`). Cloudflare's proxied DNS handles subdomain wildcarding at the edge.

**Alternatives considered**:
- `{port}.ws-{id}.{domain}` (two subdomain levels) — rejected; bypasses the Worker wildcard route which only matches one subdomain level
- `ws-{id}.{domain}:{port}` (non-standard port) — rejected; Cloudflare proxied records only support ports 80/443/8443
- `ws-{id}.{domain}/port/{port}/` (path-based) — rejected; breaks relative URLs in SPAs (assets load from wrong path)
- `{port}--ws-{id}.{domain}` (port first) — viable but less readable; workspace ID should lead for consistency

## R5: Authentication for Port-Proxied Requests

**Decision**: Reuse existing workspace JWT + session cookie. No new auth mechanism.

**Rationale**: The VM agent's `handleWorkspacePortProxy()` already calls `requireWorkspaceRequestAuth()` (workspace_routing.go:46-85), which validates:
1. Routed headers from CF Worker (`X-SAM-Workspace-Id`, `X-SAM-Node-Id`)
2. Session cookie (set after initial JWT auth)
3. Query parameter token (`?token=JWT`)

For browser-initiated requests to port-proxied apps:
- **First visit**: User navigates to `ws-{id}--3000.{domain}`. The Worker proxies to the VM agent. The VM agent sees no session cookie → redirects to an auth page or returns 401. The browser's existing workspace session cookie (set from the terminal/chat flow) should be shared across `ws-{id}*` subdomains.
- **Cookie domain**: The session cookie must be set with `Domain=.{domain}` (leading dot) so it applies to both `ws-{id}.{domain}` and `ws-{id}--3000.{domain}`.

**Key consideration**: The Worker already injects `X-SAM-Workspace-Id` when proxying workspace requests. For port-suffixed subdomains, the Worker must extract the base workspace ID (strip `--{port}`) before the D1 lookup.

**Alternatives considered**:
- Separate port-access token — rejected; adds token management complexity for no security benefit
- Public/unauthenticated port access — rejected; exposes user dev servers to the internet without auth
- OAuth flow per port — rejected; massive UX friction for opening a dev server preview

## R6: Delivery to the Browser — Events vs. Dedicated Endpoint

**Decision**: Use BOTH — emit events for real-time notifications AND provide a dedicated endpoint for current state.

### Event-based delivery (notifications)
- Emit `port.detected` and `port.closed` events via existing `appendNodeEvent()` (workspace_routing.go:462)
- Browser already polls workspace events every 10 seconds (Workspace.tsx:388-407)
- Event payload: `{ port: number, address: string, url: string }`
- Zero new WebSocket plumbing needed

### Dedicated endpoint (current state)
- `GET /workspaces/{workspaceId}/ports` — returns current list of detected listening ports
- Useful for: initial page load (don't wait for next event poll), UI refresh, API consumers
- Response: `{ ports: [{ port: number, address: string, label: string, url: string }] }`

**Alternatives considered**:
- Events only — insufficient; no way to get current state on page load without waiting for next scan cycle
- Endpoint only — insufficient; user wouldn't know when ports change without polling at a faster rate
- WebSocket push for port changes — over-engineering; events + endpoint covers all use cases

## R7: Port Label Heuristics

**Decision**: Apply common port-to-label heuristics, with `devcontainer.json` `portsAttributes` as override.

**Default labels** (hardcoded heuristic map):
| Port | Label |
|------|-------|
| 3000 | Web App |
| 3001 | Web App |
| 4200 | Angular |
| 5000 | Flask/API |
| 5173 | Vite Dev |
| 5432 | PostgreSQL |
| 6379 | Redis |
| 8000 | Django |
| 8080 | HTTP Server |
| 8888 | Jupyter |
| 9000 | PHP/API |

**Override**: If the workspace's `devcontainer.json` declares `portsAttributes` with labels, use those instead. This is best-effort — read from the container if available but don't fail if not.

**Fallback**: If no heuristic match and no devcontainer config, display the raw port number (e.g., ":4567").

## R8: UI Integration Points

**Decision**: Show Active Ports in both the WorkspaceSidebar and the ProjectChat workspace context.

### WorkspaceSidebar (Workspace.tsx view)
- New `CollapsibleSection` titled "Active Ports" between "Node Resources" and "Sessions"
- Each port as a row: port number, label, link icon
- Click opens `https://ws-{id}--{port}.{domain}` in new tab
- Binding indicator: "(local)" for `127.0.0.1`, no indicator for `0.0.0.0`
- Empty state: "No active ports detected"
- Uses same polling mechanism as workspace events (10s interval)

### ProjectChat (project chat view)
- When a workspace is active and has detected ports, show a compact "Ports" indicator
- Could be in the workspace info panel or as pills/badges near the workspace status
- Same data source: polls workspace events or dedicated endpoint

### URL construction
```
https://ws-{workspaceId}--{port}.{BASE_DOMAIN}
```
Constructed in the browser from workspace ID + detected port + `BASE_DOMAIN` environment variable.

## R9: Existing Infrastructure Inventory

### Already implemented (production-ready)
| Component | File | Status |
|-----------|------|--------|
| Port proxy handler | `packages/vm-agent/internal/server/ports_proxy.go` | Working; proxies to `127.0.0.1:{port}` |
| Workspace auth | `packages/vm-agent/internal/server/workspace_routing.go:46-85` | Working; JWT + session cookie |
| Event system | `packages/vm-agent/internal/server/workspace_routing.go:462` | Working; `appendNodeEvent()` |
| Event polling (UI) | `apps/web/src/pages/Workspace.tsx:388-407` | Working; 10s interval |
| DNS records | `apps/api/src/services/dns.ts` | Working; A records for `ws-{id}` |
| TLS termination | Cloudflare edge | Working; wildcard cert covers `*.{domain}` |
| Container discovery | `packages/vm-agent/internal/container/discovery.go` | Working; resolves container IDs |
| System info polling | `packages/vm-agent/internal/sysinfo/sysinfo.go` | Working; procfs reads |
| Worker proxy routing | `apps/api/src/index.ts:329-412` | Working; routes `ws-{id}` to VM agent |
| CollapsibleSection (UI) | `apps/web/src/components/CollapsibleSection.tsx` | Working; used throughout sidebar |

### Must be implemented
| Component | Description | Effort |
|-----------|-------------|--------|
| Port scanner (Go) | `/proc/net/tcp` parser + docker exec integration | Medium |
| Port list endpoint | `GET /workspaces/{id}/ports` on VM agent | Small |
| Port events | Emit `port.detected`/`port.closed` via appendNodeEvent | Small |
| Worker subdomain parsing | Parse `ws-{id}--{port}` in index.ts | Small |
| Proxy target fix | Use container bridge IP instead of localhost | Small |
| UI: Active Ports section | New CollapsibleSection in WorkspaceSidebar | Medium |
| UI: ProjectChat ports | Port indicators in project chat view | Small |
| Cookie domain fix | Set session cookie with `Domain=.{domain}` | Small |

## R10: Configuration Variables (Principle XI Compliance)

All values configurable via environment variables with sensible defaults:

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PORT_SCAN_INTERVAL_MS` | int | 5000 | How often to scan for listening ports |
| `PORT_SCAN_EXCLUDE` | string | "22,2375,2376,8443" | Comma-separated ports to never show |
| `PORT_SCAN_EPHEMERAL_MIN` | int | 32768 | Ports >= this are considered ephemeral and excluded |
| `PORT_PROXY_CACHE_TTL_MS` | int | 30000 | How long to cache container bridge IP |
| `PORT_SCAN_ENABLED` | bool | true | Master toggle for port scanning |

## R11: Security Considerations

1. **Auth required**: All port-proxied requests go through `requireWorkspaceRequestAuth()`. No unauthenticated access.
2. **Workspace isolation**: Each workspace's ports are only accessible to users with a valid JWT for that workspace.
3. **Port range validation**: The proxy validates `1-65535` (already implemented in `ports_proxy.go`).
4. **No SSRF risk**: The proxy target is always `{container_bridge_ip}:{port}`, not user-supplied. The port comes from URL path, not request body.
5. **Cookie scope**: Session cookies scoped to the workspace subdomain pattern; no cross-workspace leakage.

## R12: Competitive Reference

| Platform | Port Exposure Approach |
|----------|----------------------|
| **GitHub Codespaces** | Auto-detects ports, configurable visibility (private/org/public), `{codespace}-{port}.app.github.dev` |
| **Gitpod** | Auto-detects via `/proc/net/tcp`, `{port}-{workspace}.ws.gitpod.io`, configurable in `.gitpod.yml` |
| **VS Code Dev Containers** | Local port forwarding via VS Code tunnel, manual `forwardPorts` in devcontainer.json |
| **Replit** | Webview pane shows port 3000 by default, auto-detects common ports |
| **Railway** | Assigns random public port per service, no auto-detection |

SAM's approach is closest to Gitpod: auto-detect via `/proc/net/tcp`, subdomain-based routing, auth-gated access. The main differentiator is that SAM uses Cloudflare edge for TLS termination and routing, avoiding the need for per-workspace TLS certificates for port subdomains.

## R13: Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Port scan adds latency to workspace | Low | Scan runs in background goroutine; 1-3ms per scan |
| Container bridge IP changes mid-session | Low | 30s cache TTL; IP only changes on container restart (triggers re-provision) |
| User app sets CORS headers that block iframe embedding | Medium | Port URLs open in new tabs, not iframes; CORS is the app's concern |
| Many ports detected (noisy display) | Low | Filtering excludes infra + ephemeral; UI shows max ~10 ports |
| Session cookie not shared across subdomains | High | Must set `Domain=.{domain}` on cookie; verify in staging before merge |

---

## Implementation Phases (Suggested)

### Phase 1: Detection + API (VM Agent, Go)
- `/proc/net/tcp` scanner goroutine
- Container bridge IP resolution
- `GET /workspaces/{id}/ports` endpoint
- Port event emission

### Phase 2: Worker Routing (API, TypeScript)
- Parse `ws-{id}--{port}` subdomain pattern
- Route to VM agent port proxy with correct path
- Cookie domain configuration

### Phase 3: UI Integration (Web, TypeScript/React)
- Active Ports section in WorkspaceSidebar
- Port indicators in ProjectChat
- URL construction and link generation

### Phase 4: Polish
- `devcontainer.json` label reading
- Port label heuristics
- Local-only port indicators
- Tests across all layers
