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

Returns agent health status, version, uptime, and system information.

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

Opens an AI coding agent session using the Agent Communication Protocol (ACP). Session creation, prompt, cancel, stop, suspend, and resume commands are exposed through the control-plane-authenticated `/workspaces/{workspaceId}/agent-sessions/*` HTTP endpoints.

### Tab Management

```
GET /workspaces/{workspaceId}/tabs
```

Returns the list of open tabs (shell and agent sessions) for a workspace. Used to restore tabs on page refresh.

### Container Management

```
POST /workspaces
```

Create a new workspace container. Called by the API Worker during workspace provisioning.

```
DELETE /workspaces/{workspaceId}
```

Delete a workspace container and clean up resources.

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
| `CALLBACK_TOKEN` | — | JWT for authenticating callbacks |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `json` | Output format: `json` or `text` |
| `ACP_PROMPT_RETRY_MAX_RETRIES` | `2` | Max transient provider prompt retries after the initial attempt |
| `ACP_PROMPT_RETRY_INITIAL_BACKOFF` | `15s` | Initial backoff before retrying transient provider prompt errors |
| `ACP_PROMPT_RETRY_MAX_BACKOFF` | `2m` | Max exponential backoff for transient provider prompt retries |
| `ACP_NOTIF_SERIALIZE_TIMEOUT` | `5s` | Timeout for ACP notification serialization |
| `CODEX_MCP_STARTUP_TIMEOUT` | `60s` | Startup timeout for Codex MCP servers written to config.toml |
| `CODEX_MCP_TOOL_TIMEOUT` | `30m` | Tool timeout for Codex MCP servers written to config.toml |

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
