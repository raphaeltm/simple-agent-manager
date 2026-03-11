# Implementation Plan: DO-Owned ACP Session Lifecycle

**Branch**: `027-do-session-ownership` | **Date**: 2026-03-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/027-do-session-ownership/spec.md`

## Summary

Shift ACP session ownership from VM agent in-memory maps to ProjectData Durable Objects. The DO becomes the authoritative source of truth for all ACP session state (pending → assigned → running → completed/failed/interrupted), enabling VM failure detection, session forking for continuity, and future multi-VM orchestration via parent-child session trees. The VM agent is simplified to an executor role that reconciles with the control plane on restart.

## Technical Context

**Language/Version**: TypeScript 5.x (API Worker + Web UI), Go 1.24+ (VM Agent)
**Primary Dependencies**: Hono (API), Drizzle ORM (D1), React 18 + Vite (Web), Cloudflare Workers SDK (Durable Objects), `creack/pty` + `gorilla/websocket` (VM Agent), ACP Go SDK
**Storage**: Cloudflare D1 (cross-project queries), Durable Objects with SQLite (per-project session data), VM-local SQLite (message outbox)
**Testing**: Vitest + Miniflare (Worker tests), Go `testing` (VM Agent), Playwright (E2E)
**Target Platform**: Cloudflare Workers (API), Hetzner Cloud VMs (VM Agent), Browser (Web UI)
**Project Type**: Monorepo (apps/ + packages/)
**Performance Goals**: Session state transitions < 100ms, VM failure detection within configurable window (default 5 min), reconciliation < 30s
**Constraints**: DO single-threaded execution (no concurrent state corruption), ACP SDK does not support history injection, existing message outbox pattern must be preserved
**Scale/Scope**: Hundreds of concurrent sessions across dozens of VMs per deployment

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source Sustainability | ✅ PASS | Core feature, no enterprise separation needed |
| II. Infrastructure Stability | ✅ PASS | TDD required — tests before implementation for all state machine transitions |
| III. Documentation Excellence | ✅ PASS | data-model.md, contracts/, quickstart.md generated in this plan |
| IV. Approachable Code & UX | ✅ PASS | Session states clearly named, UI shows fork lineage |
| V. Transparent Roadmap | ✅ PASS | Spec 027 exists with full requirements |
| VI. Automated Quality Gates | ✅ PASS | CI covers lint, typecheck, test, build |
| VII. Inclusive Contribution | ✅ PASS | Standard patterns, no exotic abstractions |
| VIII. AI-Friendly Repository | ✅ PASS | Agent context updated after plan |
| IX. Clean Code Architecture | ✅ PASS | Changes stay within existing package boundaries (api DO, vm-agent, shared types) |
| X. Simplicity & Clarity | ✅ PASS | Reuses existing DO patterns (migrations, alarm, SQLite), no new infrastructure |
| XI. No Hardcoded Values | ✅ PASS | Detection window, reconciliation timeout, heartbeat interval all configurable via env vars with defaults |
| XII. Zero-to-Production | ✅ PASS | No new services or infrastructure — extends existing DOs |
| XIII. Fail-Fast Error Detection | ✅ PASS | Validate workspace-project binding before session creation, structured logging at every state transition |

## Project Structure

### Documentation (this feature)

```text
specs/027-do-session-ownership/
├── plan.md              # This file
├── research.md          # Phase 0: design decisions and rationale
├── data-model.md        # Phase 1: entity schemas, state machine, relationships
├── contracts/           # Phase 1: API endpoint contracts
│   ├── do-session-api.md
│   └── vm-agent-reconciliation.md
├── quickstart.md        # Phase 1: implementation quickstart
└── tasks.md             # Phase 2: task breakdown (from /speckit.tasks)
```

### Source Code (repository root)

```text
apps/api/src/
├── durable-objects/
│   ├── project-data.ts          # Extended: ACP session CRUD, state machine, fork logic
│   └── migrations.ts            # Extended: migration 008 for acp_sessions table
├── routes/
│   └── projects.ts              # Extended: session management endpoints
└── services/
    └── session-lifecycle.ts     # New: session state transition logic, fork orchestration

packages/shared/src/
├── types.ts                     # Extended: AcpSession type, session states enum
└── vm-agent-contract.ts         # Extended: reconciliation request/response schemas

packages/vm-agent/internal/
├── agentsessions/
│   └── manager.go               # Simplified: executor role, report state to control plane
├── acp/
│   └── session_host.go          # Extended: report ACP session ID on start, reconciliation
└── server/
    └── workspaces.go            # Extended: reconciliation endpoint, startup query

apps/web/src/
├── components/
│   └── SessionStatusBadge.tsx   # New: visual session state indicator
└── pages/
    └── ProjectChat.tsx          # Extended: show session states, fork lineage, interruption UI
```

**Structure Decision**: Extends existing monorepo packages. No new packages or services. The ProjectData DO gains session management methods. The VM agent gains reconciliation logic. Shared types gain session-related schemas.

## Complexity Tracking

No constitution violations requiring justification. All changes follow existing patterns.
