# VM Log Browser: Unified Log Aggregation, Tailing, and Browsing

**Status:** backlog
**Priority:** high
**Estimated Effort:** 2-3 weeks
**Created:** 2026-02-17

## Problem Statement

When a VM is provisioned and devcontainer lifecycle commands run, there is no way to observe what happened if something fails silently. Today's debugging experience:

1. **Cloud-init output** — written to `/var/log/cloud-init-output.log` on the VM but never surfaced to the user
2. **Devcontainer lifecycle commands** (`postCreateCommand`, `postStartCommand`) — stdout/stderr is lost entirely; failures are invisible
3. **Docker container build logs** — image pull progress, layer output not captured
4. **VM Agent startup** — systemd journal output not accessible from the UI
5. **Agent process lifecycle** — crashes, restarts, and errors only partially captured via the error reporter

The boot-log system (`POST /api/workspaces/:id/boot-log`) covers a narrow slice of provisioning progress (high-level steps), but does not capture the raw output that operators need to diagnose failures. Events (`GET /api/nodes/:id/events`) are in-memory only (lost on restart) and limited to structured lifecycle events.

**Real-world trigger:** After a devcontainer rebuild, `postCreateCommand` appeared to not run. No logs were available to diagnose the issue. Manual SSH and re-running the script revealed the actual error — but this should be visible from the UI.

## Current Logging Infrastructure (Gaps Analysis)

### What's Captured Today

| Source | Storage | TTL | Limitations |
|--------|---------|-----|-------------|
| Boot logs | KV (`bootlog:{workspaceId}`) | 30 min | High-level steps only; expires quickly |
| VM Agent errors | CF Workers observability | Persistent | Only errors/warnings, not info-level output |
| Node/workspace events | In-memory ring buffer | Until restart | Structured events only; max 500; volatile |
| System info | D1 `last_metrics` (heartbeat) | Overwritten | Only latest snapshot, no history |
| Client errors | CF Workers `console.error` | Persistent | Browser-side only |

### What's Lost Today

- Cloud-init raw stdout/stderr (the actual script output)
- Devcontainer CLI output (`devcontainer up` build logs, lifecycle command output)
- Docker pull/build layer output
- Agent process stdout/stderr between restarts
- systemd journal entries (vm-agent service, Docker daemon)
- Git operations during workspace bootstrap (clone, config)

## Proposed Solution

A unified log aggregation system on the VM that collects logs from all sources into a queryable local store, served via the VM Agent HTTP API with support for browsing, filtering, and live tailing.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         VM Host                             │
│                                                             │
│  Log Sources                     Ingestion Pipeline         │
│  ┌──────────────┐               ┌──────────────────┐       │
│  │ systemd      │──journald──→  │                  │       │
│  │ journal      │               │  Log Collector    │       │
│  ├──────────────┤               │  (goroutine)     │       │
│  │ Docker       │──journald──→  │                  │──┐    │
│  │ containers   │  driver       │  Reads journald  │  │    │
│  ├──────────────┤               │  + file sources  │  │    │
│  │ cloud-init   │──file watch─→ │                  │  │    │
│  │ output log   │               └──────────────────┘  │    │
│  ├──────────────┤                                     │    │
│  │ devcontainer │──pipe─→ (captured by agent          │    │
│  │ lifecycle    │          during workspace create)    │    │
│  └──────────────┘                                     │    │
│                                                       ▼    │
│                    ┌──────────────────────────────────────┐ │
│                    │         Storage Layer                │ │
│                    │                                      │ │
│                    │  SQLite logs table (persistent)      │ │
│                    │  + In-memory ring buffer (live tail) │ │
│                    │                                      │ │
│                    └──────────────┬───────────────────────┘ │
│                                   │                         │
│                    ┌──────────────▼───────────────────────┐ │
│                    │         API Layer                    │ │
│                    │                                      │ │
│                    │  GET  /logs       (browse/filter)    │ │
│                    │  GET  /logs/tail  (SSE live stream)  │ │
│                    │  GET  /logs/sources (available srcs) │ │
│                    │                                      │ │
│                    └─────────────────────────────────────-┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │   Control Plane     │
                   │   (API proxy)       │
                   │                     │
                   │ GET /api/nodes/:id/ │
                   │     logs            │
                   │     logs/tail       │
                   │     logs/sources    │
                   └──────────▲──────────┘
                              │
                   ┌──────────▼──────────┐
                   │   Browser UI        │
                   │                     │
                   │ Log Browser panel   │
                   │ in Node detail page │
                   └─────────────────────┘
```

## Research Summary

### Log Collection: journald as Unified Sink

Configure Docker with `--log-driver=journald` so container stdout/stderr flows into the systemd journal alongside the vm-agent service logs. This unifies the two largest log sources under a single queryable interface.

**Go library:** `coreos/go-systemd/v22/sdjournal` — wraps the C `sd-journal` API. Provides `AddMatch` for filtering by unit/container, `Wait(IndefiniteWait)` for follow mode, and cursor-based position tracking for resuming after restarts.

**Alternative (no CGo):** `Velocidex/go-journalctl` — pure Go parser that reads journal files directly. Avoids CGo dependency at the cost of some features.

### Log Storage: SQLite + Ring Buffer (Hybrid)

**SQLite** (extending existing `persistence/store.go`):
- The vm-agent already uses `modernc.org/sqlite` — no new dependencies
- WAL mode for concurrent read/write (API reads while collector writes)
- Indexed by timestamp, source, level for fast filtered queries
- Cursor-based pagination using monotonic auto-increment IDs
- Size/time-based pruning to bound disk usage

**In-memory ring buffer** (for live tail):
- Latest N entries (configurable, default 5000) for instant tail without disk I/O
- Fan-out to SSE subscribers (same pattern as ACP `SessionHost` message broadcasting)
- Entries written to both SQLite and ring buffer simultaneously

### Log Serving: REST + SSE

**REST** for historical browsing:
- Cursor-based pagination (same pattern as existing events endpoint)
- Filter by source, level, time range, text search
- JSON response with `entries[]`, `nextCursor`, `hasMore`

**SSE (Server-Sent Events)** for live tailing:
- Simpler than WebSocket for unidirectional streaming
- Browser `EventSource` API has built-in reconnection
- Architectural separation: WebSocket for interactive PTY/ACP, SSE for log streaming
- Backpressure via buffered channels (same pattern as `ACP_VIEWER_SEND_BUFFER`)

### Prior Art

| Tool | Approach | Key Takeaway |
|------|----------|--------------|
| **Dozzle** | Go + SSE, streams Docker logs directly | Lightweight, no storage — we improve on this with persistence |
| **Portainer** | Proxies Docker API for container logs | Token-based per-user access control |
| **Grafana Loki** | Label-based filtering, LogQL | Builder mode UX for queryless exploration; volume histogram |
| **Vercel/Railway** | SSE-based live tail with source filtering | Clean source-selector + severity toggle UX |
| **react-logviewer** | React component, built-in ANSI parsing, EventSource support | Direct SSE integration, virtual scrolling, auto-scroll toggle |

## Implementation Plan

### Phase 1: Collection & Storage (VM Agent — Go)

#### 1.1 SQLite Log Store

Add a `logs` table to the existing SQLite persistence layer.

**Schema:**
```sql
CREATE TABLE logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp  TEXT    NOT NULL,  -- ISO 8601 with microseconds
    source     TEXT    NOT NULL,  -- 'cloud-init', 'system:vm-agent', 'docker:<name>', 'devcontainer:<workspace>'
    level      TEXT    NOT NULL DEFAULT 'info',  -- 'debug', 'info', 'warn', 'error'
    message    TEXT    NOT NULL,
    metadata   TEXT,              -- JSON blob for structured fields (container_id, unit, etc.)
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_logs_timestamp ON logs(timestamp);
CREATE INDEX idx_logs_source ON logs(source);
CREATE INDEX idx_logs_level ON logs(level);
CREATE INDEX idx_logs_source_timestamp ON logs(source, timestamp);
```

**Retention policy:**
- Max rows: configurable via `LOG_STORE_MAX_ROWS` (default: 100000)
- Max age: configurable via `LOG_STORE_MAX_AGE` (default: `168h` / 7 days)
- Pruning interval: configurable via `LOG_STORE_PRUNE_INTERVAL` (default: `1h`)
- VACUUM after large deletions

**Files:** `packages/vm-agent/internal/logstore/store.go` (new package)

#### 1.2 journald Collector

Background goroutine that follows the systemd journal and ingests entries.

- Filter by relevant units: `vm-agent.service`, Docker containers (via `CONTAINER_NAME` field)
- Map journald priority levels to log levels (0-3 → error, 4 → warn, 5 → info, 6-7 → debug)
- Extract structured metadata: unit name, container name, container ID, PID
- Write to both SQLite store and ring buffer

**Configurable:**
- `LOG_JOURNAL_UNITS` — comma-separated systemd units to follow (default: `vm-agent.service`)
- `LOG_JOURNAL_DOCKER` — enable Docker container log collection (default: `true`)

**Files:** `packages/vm-agent/internal/logstore/journal_collector.go` (new)

#### 1.3 File-Based Collectors

**Cloud-init output:**
- On agent startup, ingest `/var/log/cloud-init-output.log` (one-time read)
- Optionally parse `/var/log/cloud-init.log` for structured stage events
- Source tag: `cloud-init`

**Devcontainer lifecycle output:**
- During workspace creation, the agent invokes `devcontainer up` and lifecycle commands
- Pipe stdout/stderr through a log writer that tags entries with `devcontainer:<workspaceId>`
- This requires modifying the workspace creation flow to capture subprocess output

**Configurable:**
- `LOG_CLOUD_INIT_PATH` — path to cloud-init output log (default: `/var/log/cloud-init-output.log`)

**Files:** `packages/vm-agent/internal/logstore/file_collector.go` (new)

#### 1.4 In-Memory Ring Buffer for Live Tail

Structured ring buffer holding `[]LogEntry` with fan-out broadcast:

```go
type LogBroadcaster struct {
    ring        *LogRing           // bounded ring buffer
    subscribers map[chan LogEntry]SubscriberFilter
    mu          sync.RWMutex
}
```

- Configurable capacity via `LOG_TAIL_BUFFER_SIZE` (default: 5000 entries)
- Per-subscriber filter (source, level) applied at broadcast time
- Buffered send channels per subscriber (configurable via `LOG_TAIL_SEND_BUFFER`, default: 256)
- Drop messages for slow subscribers rather than blocking

**Files:** `packages/vm-agent/internal/logstore/broadcaster.go` (new)

### Phase 2: API Endpoints (VM Agent — Go)

#### 2.1 Browse Logs

```
GET /logs?source=cloud-init&level=warn&start=...&end=...&cursor=123&limit=100&search=failed
```

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `source` | string | Filter by source prefix (e.g., `docker:` matches all containers) |
| `level` | string | Minimum severity: `debug`, `info`, `warn`, `error` |
| `start` | ISO 8601 | Time range start (inclusive) |
| `end` | ISO 8601 | Time range end (exclusive) |
| `cursor` | string | Opaque cursor (base64-encoded log ID) for pagination |
| `limit` | int | Max entries (default: 100, max via `LOG_API_MAX_LIMIT`, default: 500) |
| `search` | string | Substring search in message field |
| `direction` | string | `forward` (oldest first) or `backward` (newest first, default) |

**Response:**
```json
{
  "entries": [
    {
      "id": "12345",
      "timestamp": "2026-02-17T14:30:15.123456Z",
      "source": "devcontainer:ws-abc123",
      "level": "error",
      "message": "postCreateCommand failed: exit code 1",
      "metadata": { "workspaceId": "abc123", "command": "bash .devcontainer/post-create.sh" }
    }
  ],
  "nextCursor": "MTIzNDY=",
  "hasMore": true
}
```

**Auth:** Node management token (same as events endpoint — `requireNodeEventAuth`)

**Files:** `packages/vm-agent/internal/server/logs.go` (new)

#### 2.2 Live Tail (SSE)

```
GET /logs/tail?source=docker:*&level=info
```

Returns `text/event-stream` with JSON-encoded log entries:

```
data: {"id":"12346","timestamp":"2026-02-17T14:30:16.000Z","source":"docker:ws-abc123","level":"info","message":"Container started"}

data: {"id":"12347","timestamp":"2026-02-17T14:30:17.000Z","source":"system:vm-agent","level":"warn","message":"Heartbeat delayed"}
```

**Features:**
- Optional `source` and `level` filters (applied server-side before broadcast)
- SSE `id` field for reconnection resume (`Last-Event-ID` header)
- Keepalive comments every 30 seconds to prevent proxy timeouts
- Max concurrent tail connections per node: configurable via `LOG_TAIL_MAX_CONNECTIONS` (default: 5)

**Auth:** Same as browse endpoint

**Files:** `packages/vm-agent/internal/server/logs.go`

#### 2.3 Log Sources

```
GET /logs/sources
```

Returns available log sources for UI filter dropdown:

```json
{
  "sources": [
    { "name": "cloud-init", "label": "Cloud Init", "entryCount": 245 },
    { "name": "system:vm-agent", "label": "VM Agent", "entryCount": 1830 },
    { "name": "docker:ws-abc123", "label": "Docker: ws-abc123", "entryCount": 512 },
    { "name": "devcontainer:ws-abc123", "label": "Devcontainer: ws-abc123", "entryCount": 89 }
  ]
}
```

**Files:** `packages/vm-agent/internal/server/logs.go`

### Phase 3: Control Plane Proxy (API — TypeScript)

Proxy log endpoints through the control plane (same pattern as node events — `vm-*` DNS lacks SSL).

**New endpoints:**
- `GET /api/nodes/:id/logs` — proxy to VM Agent `GET /logs`
- `GET /api/nodes/:id/logs/tail` — proxy SSE stream from VM Agent `GET /logs/tail`
- `GET /api/nodes/:id/logs/sources` — proxy to VM Agent `GET /logs/sources`

**Auth:** User session + node ownership verification

**SSE proxy considerations:**
- The control plane Worker must stream the SSE response (not buffer it)
- Use `TransformStream` or `ReadableStream` to pipe the VM Agent response to the client
- Set appropriate headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`

**Files:** `apps/api/src/routes/nodes.ts`

### Phase 4: UI — Log Browser Panel

#### 4.1 Node Detail Page Integration

Add a `NodeLogsSection` component to the node detail page, alongside existing sections (overview, system resources, Docker, events).

**Layout:**
- Full-width section below events
- Expandable to full-screen overlay (same pattern as git changes viewer)
- Tabs: "Browse" (historical) | "Live Tail" (streaming)

**Files:** `apps/web/src/components/node/NodeLogsSection.tsx` (new)

#### 4.2 Log Browser View (Browse Tab)

**Filter bar:**
- Source dropdown (populated from `/logs/sources`) with multi-select chips
- Severity toggle buttons: Debug | Info | Warn | Error (minimum level filter)
- Time range picker: preset ranges ("Last 5 min", "Last 1 hour", "Last 24 hours", "All") + custom
- Text search input with debounce

**Log list:**
- Virtual scrolling for large result sets (consider `react-logviewer` or `@tanstack/react-virtual`)
- Each entry: timestamp, source badge (color-coded), level icon, message
- ANSI color rendering in message text
- Expandable metadata JSON for entries with metadata
- Cursor-based "Load more" pagination (infinite scroll or explicit button)
- Click-to-copy individual log line

**Files:** `apps/web/src/components/node/LogBrowser.tsx` (new)

#### 4.3 Live Tail View (Tail Tab)

**Streaming:**
- Connect to `/api/nodes/:id/logs/tail` via `EventSource`
- Source and level filter dropdowns (reconnects SSE with new params on change)
- Auto-scroll to bottom by default
- Auto-scroll pauses when user scrolls up; "Jump to latest" button appears
- Visual "Live" indicator (pulsing dot)
- Connection status indicator (connected / reconnecting / disconnected)

**Display:**
- Same entry rendering as Browse tab
- ANSI color support
- Ring buffer in the browser (last N entries, configurable, default 10000) to avoid unbounded memory

**Files:** `apps/web/src/components/node/LogTail.tsx` (new)

#### 4.4 Shared Components

- `LogEntry` component — renders a single log line with timestamp, source badge, level, message
- `LogSourceBadge` — color-coded badge per source type
- `LogLevelIcon` — severity icon (info circle, warning triangle, error X)
- `AnsiText` — renders ANSI escape sequences as styled spans (or use `anser` npm package)

**Files:** `apps/web/src/components/node/log-components.tsx` (new)

## Security Considerations

### Log Content Sanitization

Logs may contain secrets (API keys, tokens, passwords) from:
- Environment variable dumps in error messages
- curl commands with auth headers
- Git credential helper output
- Docker build args

**Mitigation layers:**
1. **Ingestion-time scrubbing:** Regex patterns applied before writing to SQLite
   - Anthropic API keys: `sk-ant-[a-zA-Z0-9-]+` → `sk-ant-[REDACTED]`
   - Bearer tokens: `Bearer [a-zA-Z0-9._-]+` → `Bearer [REDACTED]`
   - Generic key/secret patterns: `(key|token|secret|password|credential)[\s=:]+[^\s]+` → `$1=[REDACTED]`
   - AWS access keys: `AKIA[0-9A-Z]{16}` → `AKIA[REDACTED]`
2. **Display-time scrubbing:** Additional client-side patterns as a safety net
3. **Future:** Domain primitive types in Go that refuse to serialize secret values

**Configurable:** `LOG_REDACT_PATTERNS` — additional regex patterns (comma-separated)

### Access Control

- Log endpoints use same auth as existing event endpoints (`requireNodeEventAuth`)
- Node management token (JWT) required — validates node ownership
- Workspace-scoped session cookies also accepted (for workspace-specific log filtering)
- SSE connections validated on initial connect (not per-message)

### Rate Limiting

- REST browse: use existing rate limiting infrastructure
- SSE connections: max concurrent per node (default: 5, configurable: `LOG_TAIL_MAX_CONNECTIONS`)
- Response size: max entries per request (default: 500, configurable: `LOG_API_MAX_LIMIT`)

## Environment Variables

All configurable with sensible defaults per constitution Principle XI:

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_STORE_MAX_ROWS` | `100000` | Max log entries in SQLite |
| `LOG_STORE_MAX_AGE` | `168h` | Max log entry age before pruning |
| `LOG_STORE_PRUNE_INTERVAL` | `1h` | How often to run pruning |
| `LOG_JOURNAL_UNITS` | `vm-agent.service` | Systemd units to follow |
| `LOG_JOURNAL_DOCKER` | `true` | Collect Docker container logs via journald |
| `LOG_CLOUD_INIT_PATH` | `/var/log/cloud-init-output.log` | Cloud-init output log path |
| `LOG_TAIL_BUFFER_SIZE` | `5000` | In-memory ring buffer entries for live tail |
| `LOG_TAIL_SEND_BUFFER` | `256` | Per-subscriber SSE send channel buffer |
| `LOG_TAIL_MAX_CONNECTIONS` | `5` | Max concurrent SSE tail connections |
| `LOG_API_MAX_LIMIT` | `500` | Max entries per REST browse request |
| `LOG_REDACT_PATTERNS` | _(empty)_ | Additional regex redaction patterns |

## Testing Strategy

### Unit Tests
- [ ] SQLite log store: insert, query with filters, pagination, pruning
- [ ] Ring buffer: capacity, overflow, concurrent read/write
- [ ] Broadcaster: subscribe, unsubscribe, filter application, slow subscriber handling
- [ ] Secret redaction: pattern matching, edge cases
- [ ] journald entry parsing and level mapping
- [ ] File collector: cloud-init log parsing
- [ ] API parameter validation and cursor encoding/decoding

### Integration Tests
- [ ] Full ingestion pipeline: journal entry → SQLite + ring buffer
- [ ] REST browse endpoint with combined filters
- [ ] SSE tail endpoint: connection, streaming, disconnect cleanup
- [ ] Control plane proxy: REST and SSE passthrough
- [ ] Auth: valid/invalid tokens, ownership checks

### E2E Tests (Playwright)
- [ ] Node detail page shows log browser section
- [ ] Source filter dropdown populated from live data
- [ ] Severity filter changes results
- [ ] Text search filters log entries
- [ ] Live tail connects and displays new entries
- [ ] Auto-scroll pauses on user scroll, resumes on "Jump to latest"
- [ ] ANSI colors render correctly

## Success Criteria

- [ ] Cloud-init output visible in log browser after node provisioning
- [ ] Devcontainer lifecycle command output captured and browsable
- [ ] Docker container logs accessible per workspace
- [ ] VM Agent service logs visible
- [ ] Live tail streams new log entries within 1 second
- [ ] Filtering by source, level, time range, and text search works
- [ ] Logs persist across VM Agent restarts (SQLite)
- [ ] Secrets are redacted before storage
- [ ] Log viewer handles 100k+ entries without browser performance issues
- [ ] Mobile-responsive log browser (single-column, readable on 375px)

## Future Enhancements

- **Log download:** Export filtered results as `.log` or `.jsonl` file
- **Log forwarding:** Optional push to external syslog/Loki/S3
- **Workspace-scoped log view:** Log browser embedded in workspace detail page (filtered to that workspace's sources)
- **Structured JSON log parsing:** Auto-detect JSON log lines and render as expandable key-value pairs
- **Log volume histogram:** Sparkline showing log density over time (Grafana-style)
- **Alert rules:** Configurable alerts when error rate exceeds threshold
- **Cross-node log search:** Search logs across all nodes from the control plane

## Technical References

- [coreos/go-systemd sdjournal](https://pkg.go.dev/github.com/coreos/go-systemd/v22/sdjournal) — Go journald reader
- [Velocidex/go-journalctl](https://github.com/Velocidex/go-journalctl) — Pure Go journal parser
- [Docker journald logging driver](https://docs.docker.com/engine/logging/drivers/journald/)
- [Dozzle](https://dozzle.dev/) — Lightweight Go Docker log viewer (SSE-based)
- [melloware/react-logviewer](https://github.com/melloware/react-logviewer) — React log viewer with ANSI + SSE support
- [Grafana Loki Explore](https://grafana.com/docs/grafana/latest/visualizations/explore/logs-integration/) — UI patterns for log browsing
- [SQLite WAL mode](https://www.sqlite.org/wal.html) — Concurrent read/write for log store
- [SSE in Go](https://www.freecodecamp.org/news/how-to-implement-server-sent-events-in-go/) — Server-Sent Events implementation

## Estimated Effort

- Log store + collectors (Go): 3-4 days
- API endpoints + SSE (Go): 2-3 days
- Control plane proxy (TypeScript): 1-2 days
- UI log browser + tail (React): 3-4 days
- Secret redaction: 1 day
- Testing: 2-3 days
- Documentation: 1 day
- **Total: ~2-3 weeks** (single developer)

## Dependencies

- Docker daemon must be configured with `--log-driver=journald` (cloud-init change)
- Devcontainer creation flow must be modified to pipe subprocess output through log writer
- `coreos/go-systemd` or `Velocidex/go-journalctl` Go dependency added to vm-agent

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| journald CGo dependency complicates cross-compilation | Medium | Medium | Use pure-Go `go-journalctl` as fallback; or use Docker-based build |
| SQLite write contention under high log volume | Medium | Low | WAL mode + batched inserts (flush every 100ms or 100 entries) |
| Secret leakage in log entries | High | Medium | Multi-layer redaction (ingestion + display); regex patterns configurable |
| SSE proxy through Cloudflare Worker streaming limits | Medium | Low | Test with Workers streaming; fallback to direct VM Agent access via ws-* subdomain |
| Log volume fills disk on small VMs | Medium | Medium | Configurable max rows + age; pruning goroutine; monitor disk in sysinfo |

## Related Tasks

- None currently

## Notes

- This directly addresses the blind spot that caused the devcontainer `postCreateCommand` debugging session
- The existing event system (`appendNodeEvent`) should eventually be migrated to use the log store as its backend, replacing the in-memory ring buffer for events
- The boot-log KV system could be deprecated once this is in place (logs persist on-VM rather than in KV with 30-min TTL)
- Consider making the Docker `--log-driver=journald` change opt-in initially, since it changes the default Docker logging behavior on the VM
