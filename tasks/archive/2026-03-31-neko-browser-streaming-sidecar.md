# Neko Browser Streaming Sidecar for Workspaces

**Created**: 2026-03-31
**Idea**: 01KN1AHECEW7AR45KA1JVYY1PE
**Task**: 01KN1AJMZZZJFFSW2CM0FARTZC

## Problem Statement

SAM workspaces need a remote browser capability so users can view and interact with a full Chrome instance running inside the workspace's network. This enables seeing exactly what the agent sees — web apps, dev servers, database UIs — from any device including mobile. Neko (WebRTC-based browser streaming) runs as a Docker sidecar connected to the workspace's network, with socat forwarders bridging localhost ports.

## Research Findings

### VM Agent Patterns
- **Docker management**: Direct `docker` CLI calls via `exec.Command()` — no shell interpolation (security)
- **Container discovery**: `container.Discovery` with label filters, bridge IP resolution, caching with TTL
- **Route registration**: `mux.HandleFunc("METHOD /path/{param}", handler)` in `server.go:setupRoutes()`
- **Auth**: `requireWorkspaceRequestAuth()` — cookie-first, JWT query param fallback
- **Config**: `config.go` with `getEnv*` helpers (string, int, int64, duration, bool)
- **Port scanning**: `ports.Scanner` polls every 5s, caches detected ports
- **State**: `WorkspaceRuntime` struct in-memory map protected by RWMutex

### API Worker Patterns
- **Proxy routes**: `resolveSessionWorkspace()` → `proxyToVmAgent()` pattern in `files.ts`
- **Auth**: `signTerminalToken()` generates JWT, passed as `?token=` query param to VM agent
- **URL construction**: `{protocol}://{nodeId}.vm.{BASE_DOMAIN}:{port}`
- **Route registration**: Hono sub-routers exported from files, mounted in `projects/index.ts`
- **Error handling**: Map VM agent status codes, redact tokens in logs

### Cloud-Init Patterns
- **Template**: `{{ placeholder }}` syntax in `template.ts`, substitution in `generate.ts`
- **Docker pre-pulls**: `runcmd` section in cloud-init YAML
- **Config interface**: `CloudInitVariables` with optional fields and JSDoc defaults
- **Size limit**: 32KB Hetzner user-data validated by `validateCloudInitSize()`

### Web UI Patterns
- **Workspace page**: `Workspace.tsx` with tabbed interface (terminal + chat)
- **Sidebar**: `WorkspaceSidebar.tsx` with "Active Ports" section
- **Port polling**: `useWorkspacePorts` hook, 10s interval
- **Port display**: Links with Globe icon, sorted by port number

### Key Post-Mortem Lessons
- Infrastructure changes MUST provision real VMs on staging (TLS YAML postmortem)
- Cross-boundary contract tests required — URL paths, auth mechanism, request shapes (R2 upload postmortem)
- UI inputs must trace end-to-end to backend (Scaleway postmortem)
- Template output must be parsed, not string-searched (TLS YAML postmortem)

## Implementation Checklist

### Phase 1: Shared Types
- [ ] Add browser sidecar types to `packages/shared/src/types.ts`:
  - `BrowserSidecarRequest` (viewport, dpi, enableAudio)
  - `BrowserSidecarResponse` (status, url, containerName, ports)
  - `BrowserSidecarStatus` (off, starting, running, stopping, error)
  - `BrowserSidecarPortInfo` (port, target, status)
- [ ] Add Neko configuration constants to shared (defaults)
- [ ] Build shared package

### Phase 2: VM Agent — Configuration
- [ ] Add Neko config fields to `config.go`:
  - `NEKO_IMAGE` (default: `ghcr.io/m1k1o/neko/google-chrome:latest`)
  - `NEKO_SCREEN_RESOLUTION` (default: `1920x1080`)
  - `NEKO_MAX_FPS` (default: 30)
  - `NEKO_WEBRTC_PORT` (default: 8080)
  - `NEKO_SOCAT_POLL_INTERVAL_MS` (default: 5000)
  - `NEKO_MIN_RAM_MB` (default: 2048)
  - `NEKO_ENABLE_AUDIO` (default: true)
  - `NEKO_TCP_FALLBACK` (default: true)

### Phase 3: VM Agent — Browser Package
- [ ] Create `internal/browser/` package with:
  - `manager.go` — BrowserManager struct managing sidecar lifecycle per workspace
  - `container.go` — Neko container create/start/stop/remove via Docker CLI
  - `socat.go` — socat forwarder management (add, remove, diff-sync)
  - `config.go` — Neko container env var generation from config
- [ ] Implement container lifecycle:
  - `StartBrowser(workspaceID, networkName, opts)` — create and start Neko container
  - `StopBrowser(workspaceID)` — stop and remove Neko container
  - `GetStatus(workspaceID)` — get sidecar status
  - `GetPorts(workspaceID)` — list active socat forwarders
- [ ] Implement socat forwarder management:
  - `syncForwarders(containerID, ports []int)` — diff current vs desired, add/remove
  - `addForwarder(containerID, port, targetHost)` — docker exec socat in Neko container
  - `removeForwarder(containerID, port)` — kill socat process for port
- [ ] Implement port sync loop:
  - Poll DevContainer detected ports (reuse existing port scanner)
  - Diff against current socat forwarders
  - Add/remove forwarders as needed
  - Configurable poll interval via `NEKO_SOCAT_POLL_INTERVAL_MS`
- [ ] Integrate cleanup into workspace stop/delete lifecycle

### Phase 4: VM Agent — HTTP Endpoints
- [ ] Add browser sidecar routes to `server.go:setupRoutes()`:
  - `POST /workspaces/{workspaceId}/browser` — start browser sidecar
  - `GET /workspaces/{workspaceId}/browser` — get sidecar status
  - `DELETE /workspaces/{workspaceId}/browser` — stop sidecar
  - `GET /workspaces/{workspaceId}/browser/ports` — list forwarders
- [ ] Implement handlers in new `browser_handlers.go`:
  - Parse viewport/DPI from POST body
  - Use `requireWorkspaceRequestAuth()` for auth
  - Return JSON responses matching shared types
- [ ] Add BrowserManager to Server struct, initialize in server setup

### Phase 5: API Worker — Proxy Routes
- [ ] Create `apps/api/src/routes/projects/browser.ts`:
  - `POST /:id/sessions/:sessionId/browser` — proxy to VM agent
  - `GET /:id/sessions/:sessionId/browser` — proxy to VM agent
  - `DELETE /:id/sessions/:sessionId/browser` — proxy to VM agent
  - `GET /:id/sessions/:sessionId/browser/ports` — proxy to VM agent
- [ ] Reuse `resolveSessionWorkspace()` and `proxyToVmAgent()` pattern from files.ts
- [ ] Add `browserProxyRoutes` to `projects/index.ts`
- [ ] Add configurable timeout env var `BROWSER_PROXY_TIMEOUT_MS` (default: 30000)

### Phase 6: Cloud-Init — Neko Image Pre-Pull
- [ ] Add `nekoImage` and `nekoPrePull` to `CloudInitVariables` interface
- [ ] Add conditional `docker pull` command in `runcmd` section of template
- [ ] Update `generateCloudInit()` to substitute Neko placeholders
- [ ] Verify cloud-init output stays under 32KB limit

### Phase 7: Web UI — Browser Viewer
- [ ] Create `apps/web/src/components/BrowserSidecar.tsx`:
  - "Remote Browser" button (starts sidecar if not running)
  - Status indicator (off/starting/running/error)
  - Neko client iframe embed when running
  - Stop button
- [ ] Create `apps/web/src/hooks/useBrowserSidecar.ts`:
  - Start/stop/status API calls
  - Polling for status updates
  - Port list retrieval
- [ ] Add API client functions in `apps/web/src/lib/api.ts`:
  - `startBrowserSidecar(projectId, sessionId, opts)`
  - `stopBrowserSidecar(projectId, sessionId)`
  - `getBrowserSidecarStatus(projectId, sessionId)`
  - `getBrowserSidecarPorts(projectId, sessionId)`
- [ ] Integrate into workspace sidebar or toolbar
- [ ] Add mobile viewport detection and transmission

### Phase 8: Tests
- [ ] Unit tests for socat forwarder management (add, remove, diff-sync)
- [ ] Unit tests for Neko container config generation (env vars, network, ports)
- [ ] Unit tests for mobile viewport → Chrome flags mapping
- [ ] Unit tests for cloud-init template with/without pre-pull (parse YAML output)
- [ ] Contract tests: API proxy route paths match VM agent route registration
- [ ] Contract tests: Auth mechanism (terminal token) works for browser endpoints
- [ ] Contract tests: Request/response shapes match between API Worker and VM agent
- [ ] Integration test: Browser manager lifecycle (start → status → ports → stop)

### Phase 9: Documentation
- [ ] Update CLAUDE.md with Neko configuration variables
- [ ] Add env vars to `apps/api/.env.example` if applicable
- [ ] Document browser sidecar in relevant architecture docs

## Acceptance Criteria
- [ ] VM agent can create/start/stop a Neko container for a workspace
- [ ] Neko container is attached to the workspace's Docker network
- [ ] socat forwarders are created for DevContainer's exposed ports
- [ ] socat forwarders update dynamically as ports change
- [ ] Remote Chrome can access DevContainer services via localhost
- [ ] WebRTC stream is accessible via existing `ws-{id}--{port}` proxy
- [ ] SAM web UI has a "Remote Browser" component that embeds the Neko client
- [ ] Mobile viewport emulation configures Chrome to match the client device
- [ ] All configuration values are environment-variable-driven (no hardcoded values)
- [ ] Neko container is cleaned up on workspace stop/delete
- [ ] Cloud-init pre-pulls the Neko image when NEKO_PRE_PULL=true
- [ ] Cross-boundary contract tests verify API ↔ VM agent paths and auth
- [ ] Capability test exercises API → VM agent → Docker → network → socat flow

## References
- Idea: 01KN1AHECEW7AR45KA1JVYY1PE
- VM Agent server: `packages/vm-agent/internal/server/server.go`
- Docker management: `packages/vm-agent/internal/container/discovery.go`
- File proxy pattern: `apps/api/src/routes/projects/files.ts`
- Cloud-init: `packages/cloud-init/src/template.ts`, `generate.ts`
- Shared types: `packages/shared/src/types.ts`
- Workspace UI: `apps/web/src/pages/Workspace.tsx`, `components/WorkspaceSidebar.tsx`
