# Implementation Plan: Node-Level Observability & Log Aggregation

**Branch**: `020-node-observability` | **Date**: 2026-02-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/020-node-observability/spec.md`

## Summary

Provide complete node-level observability by: (1) migrating the VM agent from Go's `log` package to `log/slog` for structured JSON logging, (2) aggregating all log sources (agent, cloud-init, Docker containers, systemd journal) through journald as the central hub, (3) exposing unified log retrieval and real-time streaming endpoints from the VM agent, (4) adding proxy endpoints in the control plane API, (5) building a log viewer UI component on the node info page with filtering, search, and live streaming, and (6) fixing the broken Docker container listing that silently fails.

## Technical Context

**Language/Version**: Go 1.24 (VM Agent), TypeScript 5.x (API Worker + Web UI)
**Primary Dependencies**:
- VM Agent: `log/slog` (stdlib), `github.com/gorilla/websocket` (existing), `net/http` ServeMux (existing)
- API: Hono framework (existing), `nodeAgentRequest()` proxy pattern (existing)
- Web: React 18, Vite, existing design system `@simple-agent-manager/ui`
**Storage**: journald (systemd journal) on VM for log aggregation; no new database storage
**Testing**: Go `testing` package (VM Agent), Vitest (API + Web), Miniflare (Worker integration)
**Target Platform**: Linux VMs (Ubuntu with systemd), Cloudflare Workers (API), Browser (Web)
**Project Type**: Monorepo — changes span `packages/vm-agent`, `packages/cloud-init`, `packages/shared`, `apps/api`, `apps/web`
**Performance Goals**: Log retrieval <2s for 1000 entries; real-time streaming <5s latency; UI responsive with 10,000+ entries (virtualized)
**Constraints**: No external log aggregation services; log disk usage capped at configurable max (~500MB default via journald); backward compatible with existing nodes
**Scale/Scope**: Single-user nodes; logs bounded by journald retention; UI for one node at a time

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| I. Open Source | PASS | All changes are in the open-source core. No premium/enterprise separation needed. |
| II. Infrastructure Stability | PASS | TDD required for critical paths (log collection, Docker listing fix). Integration tests for VM agent endpoints. |
| III. Documentation Excellence | PASS | API contracts documented below. Self-hosting guide updated with journald config. |
| IV. Approachable Code & UX | PASS | Log viewer provides immediate feedback (loading states, error states). Error messages are actionable. |
| VI. Automated Quality Gates | PASS | Tests run in CI. No new manual steps. |
| VIII. AI-Friendly Repository | PASS | CLAUDE.md updated with new technology (slog). |
| IX. Clean Code Architecture | PASS | New `internal/logging` package in VM agent. Log viewer component in `apps/web/src/components/node/`. |
| X. Simplicity & Clarity | PASS | Uses stdlib slog (no external logging framework). Uses existing journalctl CLI (no CGo). |
| XI. No Hardcoded Values (NON-NEGOTIABLE) | PASS | All configurable: `LOG_RETRIEVAL_DEFAULT_LIMIT`, `LOG_RETRIEVAL_MAX_LIMIT`, `LOG_STREAM_BUFFER_SIZE`, `LOG_READER_TIMEOUT`, `LOG_STREAM_PING_INTERVAL`, `LOG_STREAM_PONG_TIMEOUT`, `SYSINFO_DOCKER_LIST_TIMEOUT`, `SYSINFO_DOCKER_STATS_TIMEOUT`, `LOG_LEVEL`, `LOG_FORMAT`. Journald disk limits via cloud-init template variables. |
| XII. Zero-to-Production (NON-NEGOTIABLE) | PASS | journald config via cloud-init template (reproducible). No manual console steps. Self-hosting docs updated. |

**Post-Phase 1 Re-check**: All gates still pass. No new infrastructure resources required (no D1/KV/R2 additions). journald configuration is part of cloud-init template (already IaC).

## Project Structure

### Documentation (this feature)

```text
specs/020-node-observability/
├── plan.md              # This file
├── research.md          # Phase 0: Technology decisions
├── data-model.md        # Phase 1: Log entry schema, Docker types
├── quickstart.md        # Phase 1: Development quickstart
└── contracts/           # Phase 1: API contracts
    ├── vm-agent-logs.md     # VM agent log endpoints
    └── control-plane-logs.md # Control plane proxy endpoints
```

### Source Code (repository root)

```text
packages/vm-agent/
├── main.go                          # UPDATE: slog setup, replace log init
├── internal/
│   ├── logging/                     # NEW: Structured logging setup
│   │   ├── setup.go                 # slog configuration, JSONHandler, LevelVar
│   │   └── setup_test.go
│   ├── logreader/                   # NEW: Unified log reader
│   │   ├── reader.go                # journalctl + file-based log reading
│   │   ├── reader_test.go
│   │   ├── stream.go                # Real-time log streaming via journalctl --follow
│   │   └── stream_test.go
│   ├── server/
│   │   ├── server.go                # UPDATE: Add log routes
│   │   ├── logs.go                  # NEW: /logs and /logs/stream handlers
│   │   └── logs_test.go             # NEW
│   ├── sysinfo/
│   │   ├── sysinfo.go               # UPDATE: Fix Docker container listing
│   │   └── sysinfo_test.go          # UPDATE: Test error handling
│   └── ...existing packages...
├── go.mod                           # No new dependencies (slog is stdlib)

packages/cloud-init/
├── src/
│   └── template.ts                  # UPDATE: Add Docker journald config + journald size limits

packages/shared/
├── src/
│   └── types.ts                     # UPDATE: Add LogEntry, LogSource types; update DockerInfo with error field

apps/api/
├── src/
│   ├── routes/
│   │   └── nodes.ts                 # UPDATE: Add log proxy endpoints
│   └── services/
│       └── node-agent.ts            # UPDATE: Add log proxy functions

apps/web/
├── src/
│   ├── components/node/
│   │   ├── LogsSection.tsx          # NEW: Log viewer component
│   │   ├── LogEntry.tsx             # NEW: Single log entry display
│   │   ├── LogFilters.tsx           # NEW: Filter controls
│   │   └── DockerSection.tsx        # UPDATE: Error state handling
│   ├── hooks/
│   │   ├── useNodeLogs.ts           # NEW: Log fetching + streaming hook
│   │   └── useNodeSystemInfo.ts     # UPDATE: Handle Docker error state
│   └── pages/
│       └── Node.tsx                 # UPDATE: Add LogsSection
```

**Structure Decision**: Changes span 5 existing packages following established monorepo conventions. Two new internal packages in vm-agent (`logging`, `logreader`). One new UI section component. No new top-level packages or apps.

## Complexity Tracking

No constitution violations to justify. All changes follow existing patterns.
