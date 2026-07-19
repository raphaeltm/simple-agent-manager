---
title: VM Agent Reference
description: The Go agent running on each VM — managing terminals, containers, and AI coding agent sessions.
---

The VM Agent is a Go binary (`packages/vm-agent/`) that runs on each provisioned node. It listens on port 8443 (HTTPS) and provides HTTP/WebSocket endpoints for terminal sessions, container management, and AI coding agent sessions (Claude Code, OpenAI Codex, Gemini CLI, Mistral Vibe, OpenCode, and Amp).

## HTTP Endpoints

### Health

```
GET /health
```

Unauthenticated liveness check. Returns only `{ "status": "healthy" }` — no workspace IDs or other sensitive data are exposed. Richer diagnostics are available via the authenticated `/system-info`, `/metrics/export`, and `/debug-package` endpoints.

### Shell Sessions

```
WebSocket /terminal/ws
WebSocket /terminal/ws/multi
```

Opens a PTY terminal session inside the workspace container. Supports:
- Binary and text frames
- Terminal resize events
- Ring buffer replay on reconnect (catches up missed output)
- Multi-session terminal tabs

### Agent Sessions

```
WebSocket /agent/ws
```

Opens an AI coding agent session using the Agent Communication Protocol (ACP). The full session lifecycle is also exposed through control-plane-authenticated HTTP endpoints:

```
GET    /workspaces/{workspaceId}/agent-sessions
POST   /workspaces/{workspaceId}/agent-sessions
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/start
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/prompt
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/cancel
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/stop
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/suspend
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/resume
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/hibernate
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/restore
```

### Tab Management

```
GET /workspaces/{workspaceId}/tabs
```

Returns the list of open tabs (shell and agent sessions) for a workspace. Used to restore tabs on page refresh.

### Container Management

```
GET    /workspaces
POST   /workspaces
POST   /workspaces/{workspaceId}/stop
POST   /workspaces/{workspaceId}/restart
POST   /workspaces/{workspaceId}/rebuild
DELETE /workspaces/{workspaceId}
GET    /workspaces/{workspaceId}/events
```

Create, list, and manage workspace containers. Called by the API Worker during workspace provisioning and lifecycle operations.

### Git

```
GET /workspaces/{workspaceId}/git/status
GET /workspaces/{workspaceId}/git/diff
GET /workspaces/{workspaceId}/git/file
GET /workspaces/{workspaceId}/git/branches
```

Read git state for the workspace repository. Used by the project chat "Changes" view.

### Files & Worktrees

```
GET    /workspaces/{workspaceId}/files/list
GET    /workspaces/{workspaceId}/files/find
GET    /workspaces/{workspaceId}/files/raw
GET    /workspaces/{workspaceId}/files/download
POST   /workspaces/{workspaceId}/files/upload
GET    /workspaces/{workspaceId}/worktrees
POST   /workspaces/{workspaceId}/worktrees
DELETE /workspaces/{workspaceId}/worktrees
```

Browse, stream, upload, and download files inside the workspace container, and manage git worktrees.

### Ports

```
GET /workspaces/{workspaceId}/ports
    /workspaces/{workspaceId}/ports/{port}/{path...}
    /workspaces/{workspaceId}/local-forward/{port}/{path...}
```

List detected listening ports and proxy HTTP traffic to a service running inside the container (powers exposed-port preview URLs).

### Diagnostics & Observability

```
GET /debug-package
GET /system-info
GET /events
GET /events/export
GET /metrics/export
GET /logs
GET /logs/stream
GET /containers
```

The `/debug-package` endpoint bundles cloud-init logs, journald, Docker logs, system info, events/metrics databases, provisioning timings, and network config into a single downloadable archive — the fastest way to diagnose a node without SSH.

## Subsystems

### PTY Manager

Manages terminal sessions with:
- **Session multiplexing** — multiple terminals per workspace
- **Ring buffer** — stores recent output for replay on reconnect
- **Lifecycle management** — automatic cleanup on disconnect

### Container Manager

Handles Docker operations:
- `devcontainer up` — build and start devcontainer from repo config
- `docker exec` — execute commands inside containers
- Git credential injection — injects GitHub tokens for push access
- Named volume management — persistent storage across container restarts

### ACP Gateway

Implements the Agent Communication Protocol for AI coding agents:
1. **Initialize** — establish protocol version and capabilities
2. **NewSession** — create a session with working directory and MCP servers
3. **Prompt** — send user prompts, receive streaming responses

Responses are serialized via `orderedPipe` to prevent token reordering from concurrent notification dispatch.

### JWT Validator

Validates workspace JWTs using the API's JWKS endpoint:
- Fetches public keys from `/.well-known/jwks.json`
- Caches keys with periodic refresh
- Extracts workspace ID and user ID from claims

## Configuration

Environment variables set by the cloud-init template:

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ID` | — | Unique node identifier |
| `CONTROL_PLANE_URL` | — | API Worker URL for callbacks |
| `CALLBACK_TOKEN_FILE` | `/etc/sam/callback-token` on cloud-init nodes | Root-only file containing the callback JWT for authenticating callbacks. `CALLBACK_TOKEN` remains a legacy fallback for already-provisioned nodes/manual runs. |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `json` | Output format: `json` or `text` |
| `ACP_PROMPT_RETRY_MAX_RETRIES` | `2` | Max transient provider prompt retries after the initial attempt |
| `ACP_PROMPT_RETRY_INITIAL_BACKOFF` | `15s` | Initial backoff before retrying transient provider prompt errors |
| `ACP_PROMPT_RETRY_MAX_BACKOFF` | `2m` | Max exponential backoff for transient provider prompt retries |
| `ACP_NOTIF_SERIALIZE_TIMEOUT` | `5s` | Timeout for ACP notification serialization |
| `STANDALONE_CLONE_FILTER` | `blob:none` | Git partial-clone filter for standalone (Cloudflare Container) workspace clones, which run synchronously inside the control plane's create-workspace request (`cloneStandaloneRepository` in `internal/server/standalone_workspace.go`). Set `off` to force full clones. The control plane forwards `CF_CONTAINER_CLONE_FILTER` here. |

### Log Retrieval Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_RETRIEVAL_DEFAULT_LIMIT` | `200` | Default entries per log page |
| `LOG_RETRIEVAL_MAX_LIMIT` | `1000` | Max entries per log page |
| `LOG_STREAM_BUFFER_SIZE` | `100` | Catch-up entries on stream connect |
| `LOG_READER_TIMEOUT` | `30s` | Timeout for journalctl reads |
| `LOG_STREAM_PING_INTERVAL` | `30s` | WebSocket ping interval |
| `LOG_STREAM_PONG_TIMEOUT` | `90s` | WebSocket pong deadline |

## Building

```bash
cd packages/vm-agent

# Build all platforms
make build-all

# Build for specific platform
GOOS=linux GOARCH=amd64 go build -o bin/vm-agent-linux-amd64 .
```

Output binaries:
- `vm-agent-linux-amd64` — production (x86)
- `vm-agent-linux-arm64` — production (ARM)
- `vm-agent-darwin-amd64` — local testing (Intel Mac)
- `vm-agent-darwin-arm64` — local testing (Apple Silicon)
