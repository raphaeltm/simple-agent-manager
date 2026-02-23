# Research: Node-Level Observability & Log Aggregation

**Feature**: 020-node-observability
**Date**: 2026-02-23

## Decision 1: Structured Logging Library for Go VM Agent

**Decision**: Use Go standard library `log/slog` with `slog.NewJSONHandler`.

**Rationale**:
- `log/slog` was introduced in Go 1.21, is stable in Go 1.24 (the VM agent's version), and is the Go team's official recommendation for structured logging.
- Zero external dependencies — slog is part of the standard library.
- `slog.SetDefault()` bridges legacy `log.Printf()` calls automatically, enabling incremental migration (25+ files currently import `log`).
- JSON output via `slog.NewJSONHandler` is machine-parseable, enabling consistent filtering in the log viewer.
- `slog.LevelVar` enables runtime log level changes via HTTP endpoint (useful for production debugging without restart).
- Performance is sufficient for the VM agent workload. High-throughput libraries like Zap/Zerolog are not needed.

**Alternatives considered**:
- **zerolog**: Fastest Go logging library but adds an external dependency. Overkill for this workload.
- **zap**: Uber's structured logger. Mature but external dependency. No benefit over slog for this use case.
- **Keep `log` package**: No structured output, no levels, no filtering capability. Insufficient for observability goals.

## Decision 2: Log Aggregation Strategy

**Decision**: Use systemd journald as the central log aggregation hub on the VM. No external services.

**Rationale**:
- journald is already running on every Ubuntu VM provisioned by the platform (systemd is a dependency of the cloud-init template).
- The VM agent runs as a systemd service, so its stdout/stderr is already captured by journald automatically.
- journald provides: structured key-value metadata, built-in size management, time-based filtering, unit-based filtering, and JSON output via `journalctl --output=json`.
- No additional software to install. Zero operational overhead.
- Configurable size limits via `/etc/systemd/journald.conf` (`SystemMaxUse`, `SystemKeepFree`).

**Alternatives considered**:
- **File-based aggregation** (`/var/log/sam/*.log` + logrotate): Simpler file serving but loses journald's structured metadata and unified querying. Would require custom rotation logic in Go.
- **Loki + Fluent Bit**: Powerful but adds two external services. Violates Constitution XII (self-hostability) and X (simplicity).
- **ELK Stack**: Massively over-engineered for single-VM observability.

## Decision 3: Docker Container Log Collection

**Decision**: Configure Docker to use the `journald` logging driver globally via `/etc/docker/daemon.json` in the cloud-init template.

**Rationale**:
- With journald as the Docker log driver, all container stdout/stderr flows into the same journal as the VM agent logs.
- journald automatically attaches `CONTAINER_ID`, `CONTAINER_NAME`, and `CONTAINER_TAG` metadata to Docker log entries, enabling per-container filtering.
- `docker logs` CLI continues to work (journald driver supports it).
- Single configuration point via cloud-init — no per-container setup needed.
- All container types (devcontainers, utility containers) are captured automatically.

**Configuration**:
```json
{
  "log-driver": "journald",
  "log-opts": {
    "tag": "docker/{{.Name}}"
  }
}
```

**Alternatives considered**:
- **json-file driver** (Docker default): Logs stored as JSON files in `/var/lib/docker/containers/`. Would require the VM agent to discover and read these files directly. No unified querying with agent logs.
- **Docker SDK for Go** (`github.com/docker/docker/client`): Large dependency (~50MB). Shelling out to `journalctl` is simpler and sufficient.

## Decision 4: Log Retrieval from journald

**Decision**: Use `journalctl` CLI (exec from Go) with `--output=json` for log retrieval. No CGo bindings.

**Rationale**:
- `journalctl` is always available on systemd-based systems. No additional packages needed.
- `--output=json` provides structured output with all metadata fields.
- Supports filtering by: unit (`-u vm-agent`), container (`CONTAINER_NAME=x`), time range (`--since`/`--until`), priority (`-p`), and line count (`-n`).
- `--follow` mode enables real-time streaming (replaces need for custom file tailing).
- No CGo compilation complexity (the `sdjournal` Go package requires `libsystemd-dev` and CGo).
- Performance: spawning `journalctl` per request is acceptable at the expected query rate (max ~1/second from UI polling).

**Alternatives considered**:
- **`github.com/coreos/go-systemd/sdjournal`**: Direct Go bindings to libsystemd. Better performance for high-frequency queries but requires CGo compilation and `libsystemd-dev` on the build machine. Not worth the complexity.
- **Reading journal files directly**: Binary format, undocumented. Not viable.

## Decision 5: Docker Container Listing Fix

**Decision**: Replace `docker stats --no-stream` with `docker ps -a --format '{{json .}}'` for container enumeration. Keep `docker stats --no-stream` only for resource metrics of known-running containers.

**Rationale**:
- The current bug is that `docker stats --no-stream` fails silently (error swallowed by `if err == nil` pattern) and returns an empty container list.
- `docker ps -a` is more reliable for listing containers — it handles all states (running, stopped, exited, paused, created) and doesn't require stats collection capability.
- Separating enumeration (`docker ps`) from metrics (`docker stats`) allows the listing to succeed even when stats collection times out.
- `--format '{{json .}}'` provides structured output that's easier to parse than the custom template currently used.
- Error state is now surfaced: a new `error` field on the Docker info response tells the UI whether the query failed.

**Alternatives considered**:
- **Docker SDK for Go**: Type-safe but adds a massive dependency. CLI is sufficient and already used throughout the codebase.
- **Fix `docker stats` silently**: Could retry or increase timeout, but `docker stats` is fundamentally wrong for container enumeration (only shows running containers with stats capability).

## Decision 6: Real-Time Log Streaming Protocol

**Decision**: Use WebSocket for real-time log streaming, following the existing `bootlog_ws.go` pattern.

**Rationale**:
- The VM agent already has a WebSocket infrastructure for boot log streaming (`BootLogBroadcaster` pattern with ring buffer, client management, and catch-up delivery).
- The control plane already proxies HTTP to the VM agent via `nodeAgentRequest()`. WebSocket proxying follows the same DNS-based routing.
- WebSocket provides bidirectional communication (client can send filter changes without reconnecting).
- The existing `gorilla/websocket` library is already a dependency.

**Alternatives considered**:
- **Server-Sent Events (SSE)**: Simpler but unidirectional. Client would need to reconnect to change filters. Also, SSE support through Cloudflare Workers proxying is less proven.
- **Long polling**: Higher latency, more complex state management. Not suitable for real-time log tailing.

## Decision 7: Cloud-Init Log Access

**Decision**: Read cloud-init log files directly from the filesystem (`/var/log/cloud-init.log` and `/var/log/cloud-init-output.log`). Parse into structured log entries.

**Rationale**:
- Cloud-init logs are static files written during provisioning. They don't change after boot completes.
- The files are always at well-known paths on Ubuntu (documented in cloud-init official docs).
- Reading files is simpler and more reliable than trying to pipe cloud-init output through journald.
- The VM agent already has filesystem access.

**Parsing approach**: Read line by line. Cloud-init.log has timestamps and severity. Cloud-init-output.log is raw command output (assign INFO level, timestamp from file modification time).

## Decision 8: Log Viewer UI Architecture

**Decision**: Virtualized list component with WebSocket streaming, filter state managed in React component, client-side search.

**Rationale**:
- Virtualized scrolling (only render visible entries) handles 10,000+ entries without performance degradation.
- WebSocket connection for real-time streaming (reuses pattern from boot log viewer).
- Client-side search over the loaded entries is sufficient for the expected volume (thousands, not millions).
- Filter state (source, level, container, search) maintained in component state; changing filters triggers a new API request and/or WebSocket reconnection with updated params.
- Follow existing `DockerSection`, `NodeEventsSection` patterns for section layout.

## Decision 9: Log Entry Schema

**Decision**: Unified JSON schema for all log sources. See `data-model.md`.

**Rationale**: All log sources (agent slog, journald, cloud-init files, Docker) produce different formats. A unified schema enables consistent rendering in the UI and consistent filtering in the API. The VM agent normalizes all sources into this schema before returning.

## Decision 10: journald Size Configuration

**Decision**: Configure via cloud-init with configurable defaults.

**Configuration** (in `/etc/systemd/journald.conf`):
```ini
[Journal]
Storage=persistent
SystemMaxUse=500M
SystemKeepFree=1G
MaxRetentionSec=7day
Compress=yes
```

**Rationale**:
- `500M` is a reasonable default for a single-user VM. Configurable via `LOG_JOURNAL_MAX_USE` env var in cloud-init template.
- `SystemKeepFree=1G` prevents log storage from exhausting disk space needed for workspaces.
- `MaxRetentionSec=7day` limits retention to 1 week. Configurable via `LOG_JOURNAL_MAX_RETENTION`.
- `Compress=yes` reduces storage by ~60% for older entries.
