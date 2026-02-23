# Quickstart: Node-Level Observability & Log Aggregation

**Feature**: 020-node-observability
**Branch**: `020-node-observability`

## Prerequisites

- Go 1.24+ (VM agent development)
- Node.js 22+ with pnpm (API + Web development)
- Docker (for testing container log collection)
- `journalctl` available (for testing log reading; Linux only — mock on macOS/Windows)

## Getting Started

```bash
git checkout 020-node-observability
pnpm install
```

## Build Order

```bash
# 1. Shared types (new LogEntry types)
pnpm --filter @simple-agent-manager/shared build

# 2. Cloud-init (updated template with journald config)
pnpm --filter @simple-agent-manager/cloud-init build

# 3. VM Agent (Go — structured logging + log reader + Docker fix)
cd packages/vm-agent && make build && cd ../..

# 4. API (new log proxy routes)
pnpm --filter @simple-agent-manager/api build

# 5. Web (new LogsSection component)
pnpm --filter @simple-agent-manager/web build
```

## Development Workflow

### VM Agent Changes

The VM agent changes are the foundation. Start here:

```bash
cd packages/vm-agent

# Run tests
go test ./...

# Run specific package tests
go test ./internal/logging/...
go test ./internal/logreader/...
go test ./internal/sysinfo/...

# Build
make build

# Run locally (requires config env vars)
NODE_ID=test-node LOG_LEVEL=debug LOG_FORMAT=text ./bin/vm-agent
```

**Key files to modify**:
- `main.go` — Replace `log.SetFlags()` with slog setup
- `internal/logging/setup.go` — New: slog configuration
- `internal/logreader/reader.go` — New: unified log reader
- `internal/logreader/stream.go` — New: real-time streaming
- `internal/server/logs.go` — New: HTTP handlers for /logs and /logs/stream
- `internal/sysinfo/sysinfo.go` — Fix: Docker container listing
- `internal/server/server.go` — Update: register new routes

### Web UI Changes

```bash
cd apps/web

# Development server
pnpm dev

# Type check
pnpm typecheck
```

**Key files**:
- `src/components/node/LogsSection.tsx` — New log viewer component
- `src/components/node/DockerSection.tsx` — Update error state handling
- `src/hooks/useNodeLogs.ts` — New log fetching/streaming hook
- `src/pages/Node.tsx` — Add LogsSection to page

### Testing the Docker Fix

The Docker container listing fix can be tested without a full VM:

```bash
cd packages/vm-agent

# Unit tests for sysinfo
go test ./internal/sysinfo/... -v

# The test should verify:
# 1. docker ps -a output is parsed correctly
# 2. Error state is returned when docker ps fails
# 3. Stats are fetched only for running containers
```

### Testing Log Reading

Log reading requires journald (Linux only). On non-Linux:

```bash
# Mock journalctl for testing
go test ./internal/logreader/... -v
# Tests use a mock command executor, not real journalctl
```

## Configuration Reference

| Env Var | Default | Description |
|---------|---------|-------------|
| `LOG_LEVEL` | `info` | VM agent log level (debug/info/warn/error) |
| `LOG_FORMAT` | `json` | Log output format (json/text) |
| `LOG_RETRIEVAL_DEFAULT_LIMIT` | `200` | Default entries per log page |
| `LOG_RETRIEVAL_MAX_LIMIT` | `1000` | Maximum entries per log page |
| `LOG_STREAM_BUFFER_SIZE` | `100` | WebSocket catch-up buffer size |
| `SYSINFO_DOCKER_LIST_TIMEOUT` | `10s` | Timeout for docker ps |
| `SYSINFO_DOCKER_STATS_TIMEOUT` | `10s` | Timeout for docker stats |

## Implementation Order (Recommended)

1. **Docker container listing fix** (sysinfo.go) — Immediate value, smallest scope
2. **Structured logging migration** (logging/setup.go + main.go) — Foundation for everything else
3. **Log reader** (logreader/reader.go) — Core log retrieval
4. **Log HTTP endpoints** (server/logs.go) — Expose logs via API
5. **Control plane proxy** (nodes.ts, node-agent.ts) — Connect API to VM agent
6. **Log viewer UI** (LogsSection.tsx) — User-facing component
7. **Real-time streaming** (logreader/stream.go + logs/stream WebSocket) — Live tailing
8. **Cloud-init updates** (template.ts) — journald + Docker log driver config
