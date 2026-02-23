# Control Plane Log Proxy Endpoints

**Feature**: 020-node-observability
**Base URL**: `https://api.{BASE_DOMAIN}`

## Authentication

Standard control plane authentication (BetterAuth session). Only the node owner can access log endpoints for their nodes.

---

## GET /api/nodes/:nodeId/logs

Proxy to VM agent `GET /logs`. Passes through all query parameters.

### Query Parameters

Same as VM agent `/logs` endpoint:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `source` | string | `all` | Filter by source |
| `level` | string | `info` | Minimum level |
| `container` | string | — | Docker container name filter |
| `since` | string | — | Start time (ISO 8601 or relative) |
| `until` | string | — | End time (ISO 8601) |
| `search` | string | — | Substring match in message |
| `cursor` | string | — | Pagination cursor |
| `limit` | number | 200 | Max entries (1-1000) |

### Response

**200 OK** — Proxied response from VM agent
```json
{
  "entries": [...],
  "nextCursor": "...",
  "hasMore": true
}
```

**404 Not Found** — Node not found or not owned by user
```json
{
  "error": "Node not found"
}
```

**502 Bad Gateway** — VM agent unreachable
```json
{
  "error": "Node agent is unreachable"
}
```

### Implementation

Uses existing `nodeAgentRequest()` pattern from `apps/api/src/services/node-agent.ts`:

```typescript
export async function getNodeLogsFromNode(
  nodeId: string,
  env: Env,
  userId: string,
  params: URLSearchParams
): Promise<NodeLogResponse> {
  return nodeAgentRequest(nodeId, env, `/logs?${params.toString()}`, {
    method: 'GET',
    userId,
  });
}
```

---

## GET /api/nodes/:nodeId/logs/stream

WebSocket proxy to VM agent `GET /logs/stream`.

### Connection Flow

1. Client connects to `wss://api.{BASE_DOMAIN}/api/nodes/:nodeId/logs/stream`
2. Control plane authenticates the user session
3. Control plane verifies node ownership
4. Control plane opens a WebSocket to the VM agent at `ws://vm-{nodeId}.{BASE_DOMAIN}:8080/logs/stream?token=<management-jwt>&source=...&level=...`
5. Control plane relays messages bidirectionally

### Query Parameters

Same filters as the VM agent `/logs/stream`, passed through to the VM agent:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `source` | string | `all` | Filter by source |
| `level` | string | `info` | Minimum level |
| `container` | string | — | Docker container name filter |

### WebSocket Messages

Same as VM agent `/logs/stream` — relayed transparently.

### Implementation Notes

- The control plane acts as a WebSocket proxy, similar to how terminal WebSocket connections are proxied.
- The management JWT is signed by the control plane and sent to the VM agent (same pattern as `signNodeManagementToken`).
- If the VM agent connection drops, the control plane sends an error message to the client and closes the connection.
- Authentication is validated before the WebSocket upgrade.

---

## GET /api/nodes/:nodeId/system-info (updated)

Existing endpoint — no URL change. The response now includes the `error` field in the `docker` section.

### Response Changes

The `docker.error` field is now included in the proxied response:

```json
{
  "docker": {
    "version": "24.0.7",
    "containers": 3,
    "containerList": [...],
    "error": null
  }
}
```

When Docker query fails on the node:
```json
{
  "docker": {
    "version": "",
    "containers": 0,
    "containerList": [],
    "error": "docker ps timed out after 10s"
  }
}
```

No changes to the control plane proxy logic — the error field passes through transparently.
