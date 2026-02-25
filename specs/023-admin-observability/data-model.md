# Data Model: Admin Observability Dashboard

**Feature Branch**: `023-admin-observability`
**Date**: 2026-02-25

## Entities

### PlatformError (Observability D1)

Persisted error from any platform source. Stored in the dedicated `OBSERVABILITY_DATABASE`.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | text | PK, UUID v4 | Unique error identifier |
| source | text | NOT NULL, enum: `client`, `vm-agent`, `api` | Error origin |
| level | text | NOT NULL, enum: `error`, `warn`, `info` | Severity level |
| message | text | NOT NULL, max 2048 chars | Error message (truncated if needed) |
| stack | text | nullable, max 4096 chars | Stack trace |
| context | text | nullable, JSON | Additional context (page URL, request path, etc.) |
| userId | text | nullable, FK to users.id (logical, not enforced cross-DB) | Associated user |
| nodeId | text | nullable | Associated node |
| workspaceId | text | nullable | Associated workspace |
| ipAddress | text | nullable | Client or agent IP |
| userAgent | text | nullable, max 512 chars | Browser user agent |
| timestamp | integer | NOT NULL, timestamp_ms | When the error occurred (client-reported) |
| createdAt | integer | NOT NULL, timestamp_ms, DEFAULT current | When the record was persisted |

**Indexes**:
- `idx_platform_errors_timestamp` on `(timestamp DESC)` -- primary sort order
- `idx_platform_errors_source_timestamp` on `(source, timestamp DESC)` -- source filter
- `idx_platform_errors_level_timestamp` on `(level, timestamp DESC)` -- level filter
- `idx_platform_errors_created_at` on `(createdAt)` -- retention purge

**Notes**:
- `userId` is a logical reference to the main `DATABASE.users.id` table but is NOT a foreign key constraint (cross-database FKs not supported in D1)
- `context` is a JSON string containing source-specific metadata:
  - Client errors: `{ pageUrl, browserInfo, componentStack }`
  - VM agent errors: `{ agentVersion, vmSize }`
  - API errors: `{ method, path, statusCode, requestId }`
- `timestamp` is the client-reported time; `createdAt` is when the Worker persisted it (may differ due to batching)

### HealthSummary (Computed, not stored)

Aggregated from existing D1 tables at query time. Not a stored entity.

| Field | Type | Source |
|-------|------|--------|
| activeNodes | number | `SELECT COUNT(*) FROM nodes WHERE status = 'running'` |
| activeWorkspaces | number | `SELECT COUNT(*) FROM workspaces WHERE status = 'running'` |
| inProgressTasks | number | `SELECT COUNT(*) FROM tasks WHERE status IN ('queued', 'delegated', 'in_progress')` |
| errorCount24h | number | `SELECT COUNT(*) FROM platform_errors WHERE timestamp > (now - 24h)` |

### LogStreamConnection (Runtime, not stored)

Managed by the AdminLogs Durable Object in-memory. Not persisted to any database.

| Field | Type | Description |
|-------|------|-------------|
| ws | WebSocket | Hibernatable WebSocket reference |
| adminUserId | string | Authenticated admin's user ID |
| filters | object | `{ levels: string[], search: string }` |
| connectedAt | number | Connection timestamp |

## State Machines

### LogStreamConnection Lifecycle

```
disconnected → connecting → connected → [paused] → disconnected
                    ↓              ↑          ↑
                 error ──→ reconnecting ──────┘
```

| State | Description | Transitions |
|-------|-------------|-------------|
| disconnected | No active WebSocket connection | → connecting (user opens stream tab) |
| connecting | WebSocket handshake in progress | → connected (success), → error (failure) |
| connected | Receiving live log entries | → paused (user pauses), → disconnected (user leaves), → reconnecting (connection lost) |
| paused | Connected but buffering entries client-side | → connected (user resumes), → disconnected (user leaves), → reconnecting (connection lost) |
| reconnecting | Auto-reconnecting after connection loss | → connected (success), → error (max retries exceeded) |
| error | Connection failed | → reconnecting (auto-retry), → disconnected (user gives up) |

### Error Ingestion Flow

```
Error Source → API Endpoint → Validate & Truncate → D1 Insert (waitUntil) → console.error (always)
                                                         ↓ (on failure)
                                                    Log failure to console, continue
```

All three ingestion paths follow the same flow:
1. **Client errors**: `POST /api/client-errors` → validate batch → write to `OBSERVABILITY_DATABASE` + `console.error`
2. **VM agent errors**: `POST /api/nodes/:id/errors` → validate batch → write to `OBSERVABILITY_DATABASE` + `console.error`
3. **API errors**: `log.error()` call → write to `OBSERVABILITY_DATABASE` + `console.error`

D1 writes use `ctx.waitUntil()` to avoid blocking the response. Failures are logged to console but never propagate to the caller.

## Relationships

```
PlatformError
  └── userId → (logical) users.id (main DATABASE)
  └── nodeId → (logical) nodes.id (main DATABASE)
  └── workspaceId → (logical) workspaces.id (main DATABASE)

HealthSummary
  └── computed from: nodes, workspaces, tasks (main DATABASE)
  └── computed from: platform_errors (OBSERVABILITY_DATABASE)

AdminLogs DO
  └── receives events from: Tail Worker (via fetch)
  └── broadcasts to: LogStreamConnection[] (WebSocket)
```

## Configuration Variables

All configurable per Constitution Principle XI.

| Variable | Default | Description |
|----------|---------|-------------|
| `OBSERVABILITY_ERROR_RETENTION_DAYS` | `30` | Days to retain errors before purge |
| `OBSERVABILITY_ERROR_MAX_ROWS` | `100000` | Maximum stored errors (oldest purged first) |
| `OBSERVABILITY_ERROR_BATCH_SIZE` | `25` | Max errors per ingestion batch |
| `OBSERVABILITY_ERROR_BODY_BYTES` | `65536` | Max request body size for error batches |
| `OBSERVABILITY_LOG_QUERY_RATE_LIMIT` | `30` | Max CF Observability API queries per minute per admin |
| `OBSERVABILITY_STREAM_BUFFER_SIZE` | `100` | Max entries buffered during pause |
| `OBSERVABILITY_STREAM_RECONNECT_DELAY_MS` | `2000` | Initial reconnect delay |
| `OBSERVABILITY_STREAM_RECONNECT_MAX_DELAY_MS` | `30000` | Max reconnect delay |
| `OBSERVABILITY_TREND_DEFAULT_RANGE_HOURS` | `24` | Default time range for error trends |
