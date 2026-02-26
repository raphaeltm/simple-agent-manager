# API Contract: Admin Observability

**Feature Branch**: `023-admin-observability`
**Date**: 2026-02-25
**Base Path**: `/api/admin/observability`

All endpoints require: `requireAuth()` + `requireApproved()` + `requireSuperadmin()`

---

## Health Summary

### `GET /api/admin/observability/health`

Returns aggregated platform health metrics.

**Response** `200 OK`:
```json
{
  "activeNodes": 3,
  "activeWorkspaces": 7,
  "inProgressTasks": 2,
  "errorCount24h": 42,
  "timestamp": "2026-02-25T12:00:00.000Z"
}
```

**Implementation notes**:
- Queries main `DATABASE` for nodes/workspaces/tasks counts
- Queries `OBSERVABILITY_DATABASE` for error count (last 24h)
- No caching; data is always fresh

---

## Error List

### `GET /api/admin/observability/errors`

Returns paginated list of platform errors.

**Query parameters**:

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | string | no | all | Filter: `client`, `vm-agent`, `api` |
| `level` | string | no | all | Filter: `error`, `warn`, `info` |
| `search` | string | no | - | Free-text search in message field |
| `startTime` | string (ISO 8601) | no | 24h ago | Start of time range |
| `endTime` | string (ISO 8601) | no | now | End of time range |
| `limit` | number | no | 50 | Results per page (max 200) |
| `cursor` | string | no | - | Pagination cursor from previous response |

**Response** `200 OK`:
```json
{
  "errors": [
    {
      "id": "err_abc123",
      "source": "client",
      "level": "error",
      "message": "TypeError: Cannot read property 'id' of undefined",
      "stack": "TypeError: Cannot read property...\n    at WorkspaceCard...",
      "context": {
        "pageUrl": "https://app.example.com/projects/p1",
        "browserInfo": "Chrome 120, macOS"
      },
      "userId": "user_xyz",
      "nodeId": null,
      "workspaceId": null,
      "ipAddress": "192.168.1.1",
      "userAgent": "Mozilla/5.0...",
      "timestamp": "2026-02-25T11:45:00.000Z"
    }
  ],
  "cursor": "eyJ0cyI6MTcwOTAyMH0=",
  "hasMore": true,
  "total": 1234
}
```

**Error responses**:
- `400`: Invalid query parameters
- `401`: Not authenticated
- `403`: Not superadmin

---

## Error Trends

### `GET /api/admin/observability/errors/trends`

Returns aggregated error counts for trend visualization.

**Query parameters**:

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `range` | string | no | `24h` | Time range: `1h`, `24h`, `7d`, `30d` |
| `interval` | string | no | auto | Bucket interval: `5m`, `1h`, `1d` (auto-selected from range if omitted) |

**Response** `200 OK`:
```json
{
  "range": "24h",
  "interval": "1h",
  "buckets": [
    {
      "timestamp": "2026-02-25T00:00:00.000Z",
      "total": 5,
      "bySource": {
        "client": 2,
        "vm-agent": 1,
        "api": 2
      }
    },
    {
      "timestamp": "2026-02-25T01:00:00.000Z",
      "total": 3,
      "bySource": {
        "client": 1,
        "vm-agent": 0,
        "api": 2
      }
    }
  ]
}
```

**Auto-interval mapping**:
- `1h` range → `5m` interval (12 buckets)
- `24h` range → `1h` interval (24 buckets)
- `7d` range → `1d` interval (7 buckets)
- `30d` range → `1d` interval (30 buckets)

---

## Historical Log Viewer (CF Observability API Proxy)

### `POST /api/admin/observability/logs/query`

Proxies a query to the Cloudflare Workers Observability API.

**Request body**:
```json
{
  "timeRange": {
    "start": "2026-02-25T10:00:00.000Z",
    "end": "2026-02-25T11:00:00.000Z"
  },
  "levels": ["error", "warn"],
  "search": "timeout",
  "limit": 50,
  "cursor": null
}
```

**Response** `200 OK`:
```json
{
  "logs": [
    {
      "timestamp": "2026-02-25T10:45:32.123Z",
      "level": "error",
      "event": "http.request",
      "message": "[client-error] TypeError: timeout",
      "details": {
        "method": "POST",
        "path": "/api/workspaces",
        "status": 500,
        "durationMs": 30000
      },
      "invocationId": "inv_abc123"
    }
  ],
  "cursor": "next_page_cursor_token",
  "hasMore": true
}
```

**Error responses**:
- `400`: Invalid query parameters
- `401`: Not authenticated
- `403`: Not superadmin
- `502`: Cloudflare Observability API unavailable
- `429`: Rate limit exceeded (configurable via `OBSERVABILITY_LOG_QUERY_RATE_LIMIT`)

**Implementation notes**:
- Transforms CF Observability API response format to a normalized structure
- Strips internal CF metadata from response
- Uses `CF_API_TOKEN` and `CF_ACCOUNT_ID` from Worker secrets
- Rate-limited per admin user (not global)
- Never exposes raw CF API errors or credentials to the client

---

## Real-Time Log Stream

### `GET /api/admin/observability/logs/stream`

WebSocket upgrade endpoint for real-time log streaming.

**Connection flow**:
1. Client sends HTTP upgrade request with auth cookie
2. Server validates superadmin auth
3. Server forwards upgrade to AdminLogs DO
4. DO accepts WebSocket and begins streaming

**Client → Server messages**:

```json
// Ping (keep-alive)
{ "type": "ping" }

// Update filters
{ "type": "filter", "levels": ["error", "warn"], "search": "timeout" }

// Pause streaming
{ "type": "pause" }

// Resume streaming
{ "type": "resume" }
```

**Server → Client messages**:

```json
// Pong (keep-alive response)
{ "type": "pong" }

// Log entry
{
  "type": "log",
  "entry": {
    "timestamp": "2026-02-25T10:45:32.123Z",
    "level": "error",
    "event": "http.request",
    "message": "Request failed with status 500",
    "details": { "method": "POST", "path": "/api/workspaces", "durationMs": 30000 },
    "scriptName": "sam-api"
  }
}

// Status update
{ "type": "status", "connected": true, "clientCount": 2 }

// Error
{ "type": "error", "message": "Stream temporarily unavailable" }
```

**Implementation notes**:
- Auth validated on HTTP upgrade (before WebSocket handshake)
- Filter changes take effect immediately without reconnection
- Server-side filtering in the DO reduces bandwidth
- Each admin client is independent (own filters, own state)
- DO uses hibernatable WebSocket API for connection management

---

## Existing Endpoints Modified

### `POST /api/client-errors` (existing, modified)

**Change**: In addition to logging to console, also writes to `OBSERVABILITY_DATABASE.platform_errors`.

**Behavior change**: None for the caller. Still returns `204 No Content`. D1 write is non-blocking (`waitUntil`).

### `POST /api/nodes/:id/errors` (existing, modified)

**Change**: Same as above. Adds D1 write alongside console logging.

**Behavior change**: None for the caller. Still returns `204 No Content`.

### `log.error()` internal function (existing, modified)

**Change**: When the logger has a database reference, error-level calls also write to `OBSERVABILITY_DATABASE.platform_errors`.

**Behavior change**: None for existing callers. Write is non-blocking and fail-silent.
