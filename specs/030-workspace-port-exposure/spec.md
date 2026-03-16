# Feature Specification: Workspace Port Exposure

**Feature Branch**: `030-workspace-port-exposure`
**Created**: 2026-03-16
**Status**: Draft
**Input**: Automatically detect and expose ports from workspace containers so users can access their running applications (Django, Vite, Flask, etc.) via browser URLs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automatic Port Detection (Priority: P0)

A developer starts a Django dev server (`python manage.py runserver 0.0.0.0:8000`) inside their workspace container. Within 5 seconds, the workspace sidebar shows "Port 8000 (Django)" as an active port with a clickable link. The developer clicks the link and their Django app opens in a new browser tab at `https://ws-ABC123--8000.example.com/`.

**Why this priority**: This is the core value proposition. Without automatic detection, users would need to manually configure port forwarding, which defeats the seamless workspace experience.

**Independent Test**: Can be tested by starting a simple HTTP server inside a workspace container, waiting for the scan interval, and verifying the port appears in the API response and event stream.

**Acceptance Scenarios**:

1. **Given** a workspace with a running container, **When** a process binds to port 8000 on `0.0.0.0`, **Then** the port is detected within `PORT_SCAN_INTERVAL_MS` and appears in the `GET /workspaces/{id}/ports` response.
2. **Given** a detected port, **When** the process stops listening, **Then** the port is removed from the active list within the next scan interval.
3. **Given** a workspace with no user-started ports, **When** the ports endpoint is queried, **Then** infrastructure ports (22, 2375, 8443) are excluded from the response.

---

### User Story 2 - Browser Access via Subdomain (Priority: P0)

A user sees "Port 3000 (Web App)" in their workspace sidebar. They click the link, which navigates to `https://ws-ABC123--3000.example.com/`. The Cloudflare Worker parses the subdomain, extracts workspace ID and port, authenticates the request using the existing session cookie, and proxies the request to the container's port 3000. The user sees their running web application.

**Why this priority**: Detection without browser access is useless. This is the other half of the core experience.

**Independent Test**: Can be tested by sending an HTTP request to `ws-{id}--{port}.{domain}` and verifying it reaches the correct container port, returns the expected response, and rejects unauthenticated requests.

**Acceptance Scenarios**:

1. **Given** a valid workspace session cookie, **When** the user navigates to `ws-{id}--3000.{domain}`, **Then** the request is proxied to port 3000 on the correct container and the response is returned.
2. **Given** no session cookie or expired JWT, **When** the user navigates to `ws-{id}--3000.{domain}`, **Then** the request is rejected with 401/redirect to auth.
3. **Given** a multi-workspace node, **When** two workspaces both run port 3000, **Then** each workspace's port is proxied to the correct container (via bridge IP isolation).

---

### User Story 3 - Active Ports in Workspace Sidebar (Priority: P0)

When a workspace is running and has detected ports, the WorkspaceSidebar shows an "Active Ports" section listing each port with its label and a clickable link. The section updates as ports come and go without requiring a page refresh.

**Why this priority**: Users need to discover which ports are available. The sidebar is the primary workspace information surface.

**Acceptance Scenarios**:

1. **Given** a workspace with ports 3000 and 8000 detected, **When** the user views the workspace, **Then** the sidebar shows both ports with labels and clickable URLs.
2. **Given** a port is detected after the page loaded, **When** the next event poll fires, **Then** the new port appears in the sidebar without a page refresh.
3. **Given** no ports are detected, **When** the user views the workspace, **Then** the section shows "No active ports detected" or is hidden.

---

### User Story 4 - Active Ports in Project Chat (Priority: P1)

When viewing the project chat with an active workspace, port information is visible alongside other workspace metadata. Users can click port links directly from the chat view without navigating to the workspace page.

**Why this priority**: The project chat is where users spend most of their time during task execution. Port access should be available there too.

**Acceptance Scenarios**:

1. **Given** a project chat with an active workspace that has detected ports, **When** the user views the chat, **Then** active ports are displayed in the workspace context area.
2. **Given** the workspace has no detected ports, **Then** no port section appears (no empty state clutter in chat).

---

### User Story 5 - Port Label Heuristics (Priority: P2)

Common ports are automatically labeled with human-friendly names (e.g., 3000 = "Web App", 8000 = "Django", 5173 = "Vite Dev"). Unknown ports show the raw port number. Labels from `devcontainer.json` `portsAttributes` override heuristics.

**Why this priority**: Nice-to-have polish. Raw port numbers are sufficient for v1.

**Acceptance Scenarios**:

1. **Given** a process listening on port 8000, **When** displayed in the sidebar, **Then** the label shows "Django" (or configured override).
2. **Given** a process listening on port 4567 with no heuristic match, **When** displayed, **Then** the label shows ":4567".

---

### Edge Cases

- What happens when the container restarts? Port list resets on next scan; stale entries cleared.
- What happens when the same port is bound by a new process? Detected as still-listening; no interruption.
- What happens when a port binds to `127.0.0.1` only? Shown with "(local)" indicator; proxy may not reach it from host — documented limitation.
- What happens when docker exec fails (container crashed)? Scanner returns empty list; events are not emitted until container recovers.
- What happens on a node with many workspaces? Each workspace scanned independently; ports isolated by container bridge IP.

---

## Functional Requirements

### Port Detection
- **FR-001**: VM agent MUST scan `/proc/net/tcp` inside each workspace container at a configurable interval (`PORT_SCAN_INTERVAL_MS`, default 5000ms).
- **FR-002**: Scanner MUST filter out ports in the exclusion list (`PORT_SCAN_EXCLUDE`, default "22,2375,2376,8443").
- **FR-003**: Scanner MUST filter out ports >= `PORT_SCAN_EPHEMERAL_MIN` (default 32768).
- **FR-004**: Scanner MUST distinguish between `0.0.0.0` (all interfaces) and `127.0.0.1` (loopback) bindings.
- **FR-005**: Port scanning MUST be disableable via `PORT_SCAN_ENABLED` (default true).

### API
- **FR-006**: VM agent MUST expose `GET /workspaces/{workspaceId}/ports` returning the current list of detected ports.
- **FR-007**: Port list response MUST include: port number, binding address, heuristic label, constructed URL.
- **FR-008**: VM agent MUST emit `port.detected` events via existing `appendNodeEvent()` when a new port is found.
- **FR-009**: VM agent MUST emit `port.closed` events when a previously-detected port stops listening.

### Routing
- **FR-010**: CF Worker MUST parse `ws-{id}--{port}` subdomain pattern and route to VM agent port proxy.
- **FR-011**: Worker MUST extract the workspace ID (strip `--{port}` suffix) for D1 lookup and auth header injection.
- **FR-012**: VM agent port proxy MUST target the container's bridge IP (from `docker inspect`), not `127.0.0.1`.
- **FR-013**: Container bridge IP MUST be cached with configurable TTL (`PORT_PROXY_CACHE_TTL_MS`, default 30000ms).

### Authentication
- **FR-014**: Port-proxied requests MUST require valid workspace authentication (existing JWT + session cookie flow).
- **FR-015**: Session cookies MUST be set with `Domain=.{domain}` to cover both `ws-{id}` and `ws-{id}--{port}` subdomains.

### UI
- **FR-016**: WorkspaceSidebar MUST show an "Active Ports" CollapsibleSection with detected ports.
- **FR-017**: Each port entry MUST be clickable, opening the port URL in a new tab.
- **FR-018**: ProjectChat MUST show active ports when a workspace is running.
- **FR-019**: Port display MUST update reactively from event polling (no page refresh required).

### Configuration
- **FR-020**: All detection parameters MUST be configurable via environment variables with documented defaults.

---

## Success Criteria

1. A user starts `python -m http.server 8000` in a workspace terminal and within 10 seconds sees "Port 8000" in the sidebar.
2. Clicking the port link opens the served content in a new browser tab.
3. Infrastructure ports (SSH, Docker, VM agent) never appear in the port list.
4. Two workspaces on the same node can both run port 3000 without conflict.
5. Unauthenticated requests to port-proxied URLs are rejected.
6. Port scanning adds < 5ms overhead per scan cycle per workspace.
7. All configuration values are overridable via environment variables.

---

## Out of Scope

- **Localhost emulation** (rewriting `localhost:3000` URLs in agent output to workspace URLs) — deferred to follow-up
- **Port forwarding to local machine** (SSH tunnel equivalent) — not applicable to browser-based platform
- **Public port sharing** (share a port URL with someone who doesn't have workspace access) — future feature
- **Automatic HTTPS for proxied apps** (TLS between proxy and container) — unnecessary; CF edge handles TLS, internal proxy is HTTP
- **Port notifications** (toast/banner when new port detected) — nice-to-have, can be added to existing notification system later
