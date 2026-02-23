# VM Agent Log Endpoints

**Feature**: 020-node-observability
**Base URL**: `http://vm-{nodeId}.{BASE_DOMAIN}:8080`

## Authentication

All log endpoints use the same authentication as existing node-level endpoints (`requireNodeEventAuth`):
1. Node management JWT via `Authorization: Bearer <token>` header (control plane proxy)
2. Node management JWT via `?token=<token>` query parameter (browser direct)
3. Any valid workspace session cookie for a workspace on this node (browser)

---

## GET /logs

Retrieve log entries from all sources in reverse chronological order with pagination.

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `source` | string | `all` | Filter by source: `all`, `agent`, `cloud-init`, `docker`, `systemd` |
| `level` | string | `info` | Minimum level: `debug`, `info`, `warn`, `error` |
| `container` | string | — | Filter Docker logs by container name |
| `since` | string | — | Start time: ISO 8601 or relative (e.g., `-1h`, `-30m`) |
| `until` | string | — | End time: ISO 8601 |
| `search` | string | — | Substring match within message field |
| `cursor` | string | — | Pagination cursor from previous response |
| `limit` | number | 200 | Max entries to return (1-1000) |

### Response

**200 OK**
```json
{
  "entries": [
    {
      "timestamp": "2026-02-23T15:30:00.123Z",
      "level": "error",
      "source": "agent",
      "message": "failed to proxy git request: connection refused",
      "metadata": {
        "workspace_id": "ws-abc123",
        "endpoint": "/git/status",
        "error": "dial tcp 127.0.0.1:3000: connect: connection refused"
      }
    },
    {
      "timestamp": "2026-02-23T15:29:55.000Z",
      "level": "info",
      "source": "docker:ws-abc123-devcontainer",
      "message": "npm install completed successfully"
    }
  ],
  "nextCursor": "s=abc123def456...",
  "hasMore": true
}
```

**400 Bad Request** — Invalid parameter values
```json
{
  "error": "invalid level: must be one of debug, info, warn, error"
}
```

### Implementation Notes

- Entries are ordered newest-first (reverse chronological).
- `nextCursor` is a journald cursor string for the last entry. Pass it as `cursor` to get the next page.
- Cloud-init logs are merged into the unified timeline by timestamp.
- If `search` is provided, only entries where the message contains the search string (case-insensitive) are returned.

---

## GET /logs/stream

Real-time log streaming via WebSocket. Delivers new log entries as they are generated.

### Connection

WebSocket upgrade at `GET /logs/stream`. Authentication via `?token=<management-jwt>` query parameter.

### Query Parameters (set at connection time)

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `source` | string | `all` | Filter by source |
| `level` | string | `info` | Minimum level |
| `container` | string | — | Docker container name filter |
| `token` | string | required | Node management JWT |

### WebSocket Messages

**Server → Client: Log Entry**
```json
{
  "type": "log",
  "entry": {
    "timestamp": "2026-02-23T15:30:00.123Z",
    "level": "error",
    "source": "agent",
    "message": "failed to proxy git request: connection refused",
    "metadata": {}
  }
}
```

**Server → Client: Catch-up Complete**
Sent after initial history replay is done, before switching to live streaming.
```json
{
  "type": "caught_up",
  "count": 50
}
```

**Server → Client: Error**
```json
{
  "type": "error",
  "message": "journalctl process exited unexpectedly"
}
```

**Client → Server: Heartbeat (ping)**
Standard WebSocket ping/pong. Server sends ping every 30 seconds, expects pong within 90 seconds.

### Behavior

1. On connection, the server sends the most recent `LOG_STREAM_BUFFER_SIZE` (default: 100) entries matching the filters as catch-up.
2. After catch-up, sends a `caught_up` message.
3. Then streams new entries as they arrive from `journalctl --follow`.
4. If the underlying `journalctl` process dies, the server sends an `error` message and attempts to restart it.
5. Connection is closed if the client doesn't respond to pings within the timeout.

---

## GET /system-info (updated)

The existing system info endpoint is updated to include Docker error state.

### Response Changes

The `docker` field in the response now includes an optional `error` field:

```json
{
  "docker": {
    "version": "24.0.7",
    "containers": 3,
    "containerList": [
      {
        "id": "abc123def456",
        "name": "ws-abc123-devcontainer",
        "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
        "status": "Up 2 hours",
        "state": "running",
        "cpuPercent": 2.5,
        "memUsage": "150MiB / 2GiB",
        "memPercent": 7.3,
        "createdAt": "2026-02-23T13:30:00Z"
      },
      {
        "id": "def789ghi012",
        "name": "ws-abc123-repo-copy",
        "image": "alpine:3.18",
        "status": "Exited (0) 1 hour ago",
        "state": "exited",
        "cpuPercent": 0,
        "memUsage": "0B / 0B",
        "memPercent": 0,
        "createdAt": "2026-02-23T13:28:00Z"
      }
    ],
    "error": null
  }
}
```

When Docker query fails:
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
