# Workspace Port Forwarding CLI Command

## Problem

Users need a way to access services running inside SAM workspaces from their local machine. Currently, port exposure only works via the MCP `expose_port` tool (agent-initiated) or the web UI. There's no CLI command to forward workspace ports to localhost for direct development use.

## Design (confirmed by user)

**Option A** — resource-scoped `workspace` namespace:

```bash
sam workspace <workspaceId> forward              # forward all detected ports
sam workspace <workspaceId> forward --port 3000   # forward specific port(s)
sam workspace <workspaceId> forward --port 3000 --port 8080  # multiple specific ports
sam workspace <workspaceId> ports                 # list detected ports
```

- Foreground command, Ctrl+C to stop
- Forward all auto-detected ports by default
- Optional `--port` flag to limit to specific ports
- Streams traffic log lines to stderr
- Opens local TCP listeners that proxy HTTP traffic through Cloudflare `ws-{id}--{port}.{baseDomain}` URLs

## Research Findings

### Existing Infrastructure
- **VM agent port scanner** (`packages/vm-agent/internal/ports/scanner.go`): Scans `/proc/net/tcp` inside container, detects open ports
- **VM agent port list endpoint** (`GET /workspaces/{id}/ports`): Returns `{ports: [{port, address, label, url, detectedAt}], diagnostics: {...}}`
- **VM agent network-info** (`GET /workspaces/{id}/mcp/network-info`): Returns `{workspaceUrl, baseDomain, ports: [{port, externalUrl}]}`
- **Port access tokens** (`apps/api/src/services/jwt.ts:signPortAccessToken`): Per-port JWT tokens (15min expiry), appended as `?port_token=` query param
- **Workspace CRUD API** (`GET /api/workspaces/:id`): Returns workspace details including `url` field (session-cookie auth)
- **URL pattern**: `https://ws-{workspaceId}--{port}.{baseDomain}`

### CLI Architecture
- Custom arg parser (no Cobra), `packages/cli/internal/cli/`
- `Runtime` struct with dependency injection (HTTPDoer, ConfigEnv, Runner, I/O streams)
- Auth via session cookies in `Cookie` header
- Commands dispatched in `run.go` via namespace switch
- No `workspace` namespace exists yet

### Port Proxying
- The existing Cloudflare proxy handles `ws-{id}--{port}.{domain}` routing to the VM agent
- VM agent port proxy (`ports_proxy.go`) forwards to the container's bridge IP
- Port access tokens authenticate the request

### Key API Endpoints Needed
1. `GET /api/workspaces/:id` — get workspace details (exists, session-cookie auth)
2. **NEW**: `GET /api/workspaces/:id/ports` — list detected ports for a workspace (proxied to VM agent, session-cookie auth)
3. **NEW**: `POST /api/workspaces/:id/port-token` — get a port access JWT for a specific port (session-cookie auth)

## Implementation Checklist

### API Layer (apps/api)
- [ ] Add `GET /api/workspaces/:id/ports` endpoint — proxies to VM agent `GET /workspaces/{id}/ports`, requires session-cookie auth + ownership
- [ ] Add `POST /api/workspaces/:id/port-token` endpoint — generates port access JWT for a given port, requires session-cookie auth + ownership

### CLI: Workspace Namespace & Forward Command
- [ ] Add `WorkspaceResponse` type in `types.go` with fields: `id`, `url`, `status`, `vmIp`, `nodeId`
- [ ] Add `PortsResponse` and `DetectedPort` types in `types.go`
- [ ] Add `APIClient.GetWorkspace(ctx, workspaceId)` method in `client.go`
- [ ] Add `APIClient.GetWorkspacePorts(ctx, workspaceId)` method in `client.go`
- [ ] Add `APIClient.GetPortToken(ctx, workspaceId, port)` method in `client.go`
- [ ] Add `workspace` case in `run.go` namespace switch
- [ ] Implement `runWorkspace()` dispatcher for subcommands `forward` and `ports`
- [ ] Implement `runWorkspaceForward()`:
  - Parse `--port` flag (repeatable)
  - Fetch workspace details to get base domain from URL
  - If no `--port` flags: fetch detected ports from API
  - For each port: start local TCP listener on `localhost:<port>`
  - On each incoming connection: HTTP reverse proxy to `https://ws-{id}--{port}.{baseDomain}` with port_token
  - Refresh port_token before expiry (tokens last 15min)
  - Print active forwarding table to stderr
  - Log proxied requests to stderr
  - Handle SIGINT/SIGTERM for graceful shutdown
- [ ] Implement `runWorkspacePorts()` — list detected ports (text + JSON output)
- [ ] Add `--local` flag support for port remapping (e.g., `--port 3000 --local 8080`)

### CLI: Help Text & Output
- [ ] Update `helpText()` in `run.go` to include workspace commands
- [ ] Format forwarding status output (table of port mappings)
- [ ] Format port list output for `ports` subcommand

### Tests
- [ ] Test workspace namespace dispatch (unknown subcommand, missing args)
- [ ] Test `workspace <id> ports` with mocked API response
- [ ] Test `workspace <id> forward` argument parsing (--port flag, multiple ports)
- [ ] Test `workspace <id> forward` with no --port flag fetches all detected ports
- [ ] Test port token refresh logic
- [ ] Test graceful shutdown behavior

## Acceptance Criteria

- [ ] `sam workspace <id> forward` starts local listeners for all detected ports
- [ ] `sam workspace <id> forward --port 3000` forwards only port 3000
- [ ] `sam workspace <id> forward --port 3000 --port 8080` forwards multiple ports
- [ ] `sam workspace <id> ports` lists detected ports (text and JSON output)
- [ ] Ctrl+C gracefully shuts down all listeners
- [ ] Traffic is proxied through Cloudflare URLs with valid port tokens
- [ ] Port tokens are refreshed before expiry
- [ ] Clear error messages for: workspace not found, workspace not running, no ports detected
- [ ] All Go tests pass
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes

## References

- Previous session: "Implement CLI command for workspace port forwarding" (session ad675572)
- Port scanner: `packages/vm-agent/internal/ports/scanner.go`
- Port proxy: `packages/vm-agent/internal/server/ports_proxy.go`
- MCP tools: `packages/vm-agent/internal/server/mcp_tools.go`
- Workspace CRUD: `apps/api/src/routes/workspaces/crud.ts`
- JWT signing: `apps/api/src/services/jwt.ts`
- CLI policy: high Go/QA quality standards (project policy)
