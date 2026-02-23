# Data Model: Node-Level Observability & Log Aggregation

**Feature**: 020-node-observability
**Date**: 2026-02-23

## Entities

### LogEntry

A unified log entry normalized from any source on the node.

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string (ISO 8601) | When the event occurred |
| `level` | enum: `debug`, `info`, `warn`, `error` | Severity level |
| `source` | string | Origin identifier (see LogSource) |
| `message` | string | Human-readable log message |
| `metadata` | object (optional) | Structured key-value data from the original log entry |

**Source identifier format**:
- `agent` — VM agent application logs
- `cloud-init` — Cloud-init provisioning logs (from `/var/log/cloud-init.log`)
- `cloud-init-output` — Cloud-init command output (from `/var/log/cloud-init-output.log`)
- `docker:<container-name>` — Docker container stdout/stderr (e.g., `docker:ws-abc123-devcontainer`)
- `systemd` — systemd journal entries for the vm-agent service unit

### LogSource

An enumeration of log source categories used for filtering.

| Value | Description | journald Query |
|-------|-------------|----------------|
| `agent` | VM agent structured logs | `_SYSTEMD_UNIT=vm-agent.service` |
| `cloud-init` | Provisioning logs | File read: `/var/log/cloud-init*.log` |
| `docker` | All Docker container logs | `_TRANSPORT=journal` + `CONTAINER_NAME` present |
| `systemd` | systemd journal (vm-agent unit) | `_SYSTEMD_UNIT=vm-agent.service` |
| `all` | All sources combined | No filter |

### LogFilter

Parameters for filtering log retrieval and streaming.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `source` | string | `all` | Log source filter (see LogSource values) |
| `level` | string | `info` | Minimum severity level (debug, info, warn, error) |
| `container` | string (optional) | — | Filter Docker logs to a specific container name |
| `since` | string (optional) | — | ISO 8601 timestamp or relative (e.g., `-1h`) |
| `until` | string (optional) | — | ISO 8601 timestamp for end of range |
| `search` | string (optional) | — | Text search substring within message field |
| `cursor` | string (optional) | — | Pagination cursor for next page |
| `limit` | number | 200 | Maximum entries to return (max 1000) |

### DockerInfo (updated)

The existing `DockerInfo` type with added error state.

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Docker engine version |
| `containers` | number | Total container count |
| `containerList` | ContainerInfo[] | List of all containers |
| `error` | string (optional) | Error message if Docker query failed |

### ContainerInfo (updated)

Updated container information from `docker ps` + `docker stats`.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Container ID (short form) |
| `name` | string | Container name |
| `image` | string | Image name |
| `status` | string | Human-readable status (e.g., "Up 2 hours", "Exited (1) 5 minutes ago") |
| `state` | enum: `running`, `exited`, `paused`, `created`, `restarting`, `removing`, `dead` | Machine-readable state |
| `cpuPercent` | number | CPU usage percentage (0 if not running) |
| `memUsage` | string | Memory usage string (e.g., "150MiB / 2GiB") |
| `memPercent` | number | Memory usage percentage (0 if not running) |
| `createdAt` | string | Container creation timestamp |

## State Transitions

### Log Viewer Connection States

```
disconnected ──[user opens page]──> connecting
connecting ──[WebSocket open]──> streaming
connecting ──[timeout/error]──> error
streaming ──[new entries arrive]──> streaming (append)
streaming ──[user pauses]──> paused
paused ──[user resumes]──> streaming (catch-up)
streaming ──[connection lost]──> reconnecting
reconnecting ──[reconnect success]──> streaming (catch-up)
reconnecting ──[max retries]──> error
error ──[user retries]──> connecting
streaming ──[user navigates away]──> disconnected
```

### Docker Query States (UI)

```
loading ──[response OK, containers > 0]──> showing-containers
loading ──[response OK, containers = 0]──> no-containers
loading ──[response has error field]──> query-failed
loading ──[HTTP error]──> query-failed
```

## Shared Types (TypeScript)

These types are added to `packages/shared/src/types.ts`:

```typescript
// Log entry from any source on the node
export interface NodeLogEntry {
  timestamp: string;      // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;         // e.g., "agent", "docker:ws-abc", "cloud-init"
  message: string;
  metadata?: Record<string, unknown>;
}

// Log source filter values
export type NodeLogSource = 'all' | 'agent' | 'cloud-init' | 'docker' | 'systemd';

// Log level filter values
export type NodeLogLevel = 'debug' | 'info' | 'warn' | 'error';

// Parameters for log retrieval
export interface NodeLogFilter {
  source?: NodeLogSource;
  level?: NodeLogLevel;
  container?: string;
  since?: string;
  until?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

// Response from log retrieval endpoint
export interface NodeLogResponse {
  entries: NodeLogEntry[];
  nextCursor?: string | null;
  hasMore: boolean;
}

// Updated DockerInfo with error state
export interface DockerInfoWithError {
  version: string;
  containers: number;
  containerList: ContainerInfo[];
  error?: string;          // NEW: populated when Docker query fails
}

// Updated container info with state enum
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;          // Human-readable (e.g., "Up 2 hours")
  state: ContainerState;   // Machine-readable enum
  cpuPercent: number;
  memUsage: string;
  memPercent: number;
  createdAt: string;
}

export type ContainerState =
  | 'running'
  | 'exited'
  | 'paused'
  | 'created'
  | 'restarting'
  | 'removing'
  | 'dead';
```

## Go Types (VM Agent)

```go
// LogEntry represents a unified log entry from any source.
type LogEntry struct {
    Timestamp string            `json:"timestamp"`
    Level     string            `json:"level"`
    Source    string            `json:"source"`
    Message  string            `json:"message"`
    Metadata map[string]any    `json:"metadata,omitempty"`
}

// LogFilter represents query parameters for log retrieval.
type LogFilter struct {
    Source    string // "all", "agent", "cloud-init", "docker", "systemd"
    Level     string // "debug", "info", "warn", "error"
    Container string // Docker container name filter
    Since     string // ISO 8601 or relative
    Until     string // ISO 8601
    Search    string // Substring match in message
    Cursor    string // Pagination cursor (journald cursor)
    Limit     int    // Max entries (default 200, max 1000)
}

// LogResponse is the HTTP response for log retrieval.
type LogResponse struct {
    Entries    []LogEntry `json:"entries"`
    NextCursor *string    `json:"nextCursor"`
    HasMore    bool       `json:"hasMore"`
}
```

## Configuration (Environment Variables)

All values follow Constitution Principle XI (configurable with defaults).

| Variable | Default | Description | Used In |
|----------|---------|-------------|---------|
| `LOG_LEVEL` | `info` | VM agent minimum log level | VM Agent |
| `LOG_FORMAT` | `json` | Log output format (`json` or `text`) | VM Agent |
| `LOG_RETRIEVAL_DEFAULT_LIMIT` | `200` | Default entries per log page | VM Agent |
| `LOG_RETRIEVAL_MAX_LIMIT` | `1000` | Maximum entries per log page | VM Agent |
| `LOG_STREAM_BUFFER_SIZE` | `100` | WebSocket send buffer size | VM Agent |
| `LOG_JOURNAL_MAX_USE` | `500M` | journald SystemMaxUse | Cloud-Init |
| `LOG_JOURNAL_MAX_RETENTION` | `7day` | journald MaxRetentionSec | Cloud-Init |
| `LOG_JOURNAL_KEEP_FREE` | `1G` | journald SystemKeepFree | Cloud-Init |
| `SYSINFO_DOCKER_LIST_TIMEOUT` | `10s` | Timeout for `docker ps` command | VM Agent |
| `SYSINFO_DOCKER_STATS_TIMEOUT` | `10s` | Timeout for `docker stats` command | VM Agent |
