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
GET    /workspaces/{workspaceId}/agent-sessions/{sessionId}/prompt-receipts/{deliveryId}
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/checkpoint-rollovers
GET    /workspaces/{workspaceId}/agent-sessions/{sessionId}/checkpoint-rollovers/{operationId}
GET    /workspaces/{workspaceId}/agent-capabilities
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/cancel
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/stop
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/suspend
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/resume
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/hibernate
POST   /workspaces/{workspaceId}/agent-sessions/{sessionId}/restore
```

#### Durable prompt delivery protocol

Protocol version 1 adds an optional exact-once delivery envelope to both the session `start` request (for its `initialPrompt`) and the existing `prompt` endpoint. Existing callers may omit `deliveryId` and preserve the legacy behavior. A versioned follow-up caller sends:

```json
{
  "protocolVersion": 1,
  "deliveryId": "stable-control-plane-delivery-id",
  "messageId": "chat-message-id",
  "prompt": "Prompt text"
}
```

For `start`, place the same `protocolVersion`, `deliveryId`, and optional `messageId` alongside the existing `agentType` and `initialPrompt` fields. The VM persists the receipt before invocation. Repeating the same delivery ID and identical request never invokes the agent twice. After a lost HTTP response, read the receipt endpoint before deciding what to do. An `in_flight` receipt discovered after the VM Agent runtime has restarted becomes `ambiguous`; it is deliberately never replayed because the prior agent invocation may have occurred. Receipts store a request hash and lifecycle metadata, not prompt text.

Capabilities are VM-authoritative. Version 1 uses the following nested shape; callers must retain the returned `runtimeIdentity` when reconciling a lost response:

```json
{
  "protocolVersion": 1,
  "runtimeIdentity": "vm-runtime-id",
  "promptReceipts": {
    "supported": true,
    "lookup": true,
    "states": ["accepted", "in_flight", "completed", "ambiguous"]
  },
  "checkpointRollover": {
    "supported": true,
    "automatic": false,
    "states": ["accepted", "in_progress", "completed", "superseded", "failed"],
    "defaultGraceMs": 30000,
    "maxGraceMs": 120000,
    "operationTimeoutMs": 120000
  }
}
```

A newly accepted versioned prompt returns HTTP 202; an identical duplicate returns HTTP 200. Both use the same response envelope:

```json
{
  "status": "accepted",
  "sessionId": "acp-session-id",
  "receipt": {
    "deliveryId": "stable-control-plane-delivery-id",
    "state": "in_flight",
    "runtimeIdentity": "vm-runtime-id",
    "acceptedAt": 1786312800123,
    "completedAt": null
  }
}
```

`acceptedAt` and `completedAt` are Unix epoch milliseconds. HTTP 409 with envelope status `not_ready` proves non-acceptance for the current attempt; HTTP 409 with status `conflict` means the delivery ID belongs to different prompt intent. Receipt lookup returns HTTP 404 with a `not_found` receipt carrying the current VM runtime identity. Automatic replay is allowed only for that positive same-runtime `not_found` result. A changed runtime identity, an unstructured 404, or an unavailable capability/receipt probe is terminally ambiguous and must not be replayed.

#### Checkpoint rollover protocol

Checkpoint rollover is opt-in and inert until the control plane calls it. Discover support and configured bounds from `GET /workspaces/{workspaceId}/agent-capabilities`, then submit:

```json
{
  "protocolVersion": 1,
  "operationId": "stable-rollover-operation-id",
  "graceMs": 30000
}
```

The operation moves through `accepted`, `in_progress`, then `completed`, `superseded`, or `failed`. The VM sends ACP `session/cancel` and `session/close`, waits the bounded grace, force-stops the harness if necessary, restarts it, and requires `LoadSession` of the exact previous ACP session ID. Failure to load that session is explicit; the VM never creates a fresh session as fallback. Natural completion and explicit user cancellation supersede checkpoint preemption. Repeat the same operation ID to reconcile a lost response; a different request with the same ID returns `operation_id_conflict`.

Activity reports use one immutable `promptStartedAt` epoch for the accepted prompt. Periodic re-reports reuse it, and only a newly accepted prompt gets a new epoch. Hard deadlines report terminal `error`, not `idle`, so an errored host cannot appear available with stale work.

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

Node-wide diagnostics require a node-scoped management token issued by the control plane. Workspace browser sessions and workspace-scoped management tokens are not accepted for these routes because a single node can host multiple workspaces. User-facing node observability should go through the control-plane `/api/nodes/{nodeId}/...` proxy routes, which verify node ownership and sign the node-scoped token for the VM Agent.

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

Validates workspace and node-management JWTs using the API's JWKS endpoint:

- Fetches public keys from `/.well-known/jwks.json`
- Caches keys with periodic refresh
- Enforces workspace claims on workspace-scoped routes
- Enforces node-scoped management tokens on node-wide diagnostic routes

## Configuration

Environment variables set by the cloud-init template:

| Variable                           | Default                                       | Description                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ID`                          | —                                             | Unique node identifier                                                                                                                                                                                                                                                                                                                |
| `CONTROL_PLANE_URL`                | —                                             | API Worker URL for callbacks                                                                                                                                                                                                                                                                                                          |
| `CALLBACK_TOKEN_FILE`              | `/etc/sam/callback-token` on cloud-init nodes | Root-only file containing the callback JWT for authenticating callbacks. `CALLBACK_TOKEN` remains a legacy fallback for already-provisioned nodes/manual runs.                                                                                                                                                                        |
| `LOG_LEVEL`                        | `info`                                        | Log level: `debug`, `info`, `warn`, `error`                                                                                                                                                                                                                                                                                           |
| `LOG_FORMAT`                       | `json`                                        | Output format: `json` or `text`                                                                                                                                                                                                                                                                                                       |
| `ACP_PROMPT_RETRY_MAX_RETRIES`     | `2`                                           | Max transient provider prompt retries after the initial attempt                                                                                                                                                                                                                                                                       |
| `ACP_PROMPT_RETRY_INITIAL_BACKOFF` | `15s`                                         | Initial backoff before retrying transient provider prompt errors                                                                                                                                                                                                                                                                      |
| `ACP_PROMPT_RETRY_MAX_BACKOFF`     | `2m`                                          | Max exponential backoff for transient provider prompt retries                                                                                                                                                                                                                                                                         |
| `ACP_CHECKPOINT_PREEMPT_GRACE`     | `30s`                                         | Grace after ACP cancel/close before force-stopping the harness                                                                                                                                                                                                                                                                        |
| `ACP_CHECKPOINT_PREEMPT_MAX_GRACE` | `2m`                                          | Maximum `graceMs` accepted by the rollover endpoint                                                                                                                                                                                                                                                                                   |
| `ACP_CHECKPOINT_ROLLOVER_TIMEOUT`  | `2m`                                          | Deadline for the complete stop, restart, and strict LoadSession operation                                                                                                                                                                                                                                                             |
| `ACP_NOTIF_SERIALIZE_TIMEOUT`      | `5s`                                          | Timeout for ACP notification serialization                                                                                                                                                                                                                                                                                            |
| `ACP_HARNESS_ACTIVITY_REPORT_DEBOUNCE` | `750ms`                                    | Debounce window for coalescing ACP harness/tool-call activity reports before POSTing activity callbacks                                                                                                                                                                                                                                |
| `STANDALONE_CLONE_FILTER`          | `blob:none`                                   | Git partial-clone filter for standalone (Cloudflare Container) workspace clones, which run synchronously inside the control plane's create-workspace request (`cloneStandaloneRepository` in `internal/server/standalone_workspace.go`). Set `off` to force full clones. The control plane forwards `CF_CONTAINER_CLONE_FILTER` here. |
| `GRACEFUL_SHUTDOWN_TIMEOUT`        | `30s`                                         | Max time to wait for VM-agent HTTP server shutdown after SIGTERM                                                                                                                                                                                                                                                                      |
| `SYSTEM_PROVISIONING_TIMEOUT`      | `15m`                                         | Max time for workspace host provisioning before bootstrap                                                                                                                                                                                                                                                                             |
| `CF_IP_FETCH_TIMEOUT`              | `10s`                                         | Timeout for fetching Cloudflare IP ranges during firewall provisioning                                                                                                                                                                                                                                                                |
| `BOOT_LOG_HTTP_TIMEOUT`            | `10s`                                         | Timeout for boot-log callbacks to the control plane                                                                                                                                                                                                                                                                                   |
| `MCP_SHORT_COMMAND_TIMEOUT`        | `10s`                                         | Timeout for short MCP workspace probes such as branch and credential checks                                                                                                                                                                                                                                                           |
| `MCP_DIFF_COMMAND_TIMEOUT`         | `30s`                                         | Timeout for MCP diff-summary git commands                                                                                                                                                                                                                                                                                             |
| `MCP_BUILD_PREPARE_TIMEOUT`        | `30s`                                         | Timeout for MCP build/publish preparation probes                                                                                                                                                                                                                                                                                      |
| `JWKS_FETCH_TIMEOUT`               | `10s`                                         | Timeout for VM-agent startup JWKS fetches                                                                                                                                                                                                                                                                                             |
| `ACP_CREDENTIAL_SYNC_TIMEOUT`      | `10s`                                         | Timeout for ACP auth-file sync-back during shutdown                                                                                                                                                                                                                                                                                   |
| `ACP_ACTIVITY_REPORT_TIMEOUT`      | `10s`                                         | Timeout for each ACP activity callback attempt                                                                                                                                                                                                                                                                                        |
| `DEVCONTAINER_CACHE_PUSH_TIMEOUT`  | `10m`                                         | Timeout for best-effort devcontainer cache image pushes                                                                                                                                                                                                                                                                               |
| `DEPLOY_PREFLIGHT_COMMAND_TIMEOUT` | `15s`                                         | Timeout for deployment preflight diagnostic commands                                                                                                                                                                                                                                                                                  |
| `LOG_STREAM_PING_WRITE_TIMEOUT`    | `10s`                                         | Write deadline for log-stream WebSocket ping frames                                                                                                                                                                                                                                                                                   |

### Log Retrieval Settings

| Variable                      | Default | Description                        |
| ----------------------------- | ------- | ---------------------------------- |
| `LOG_RETRIEVAL_DEFAULT_LIMIT` | `200`   | Default entries per log page       |
| `LOG_RETRIEVAL_MAX_LIMIT`     | `1000`  | Max entries per log page           |
| `LOG_STREAM_BUFFER_SIZE`      | `100`   | Catch-up entries on stream connect |
| `LOG_READER_TIMEOUT`          | `30s`   | Timeout for journalctl reads       |
| `LOG_STREAM_PING_INTERVAL`    | `30s`   | WebSocket ping interval            |
| `LOG_STREAM_PONG_TIMEOUT`     | `90s`   | WebSocket pong deadline            |

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
