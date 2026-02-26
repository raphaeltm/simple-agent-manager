# Implementation Plan: Admin Observability Dashboard

**Branch**: `023-admin-observability` | **Date**: 2026-02-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/023-admin-observability/spec.md`

## Summary

Add a superadmin observability dashboard providing: (1) unified error storage and browsing across client, VM agent, and API sources in a dedicated D1 database, (2) platform health overview with real-time metrics, (3) historical API Worker log viewer via the Cloudflare Workers Observability API, (4) real-time log streaming via Tail Worker + Durable Object + WebSocket, and (5) error trend visualization. Extends the existing `/admin` page with tab-based navigation.

## Technical Context

**Language/Version**: TypeScript 5.x (API Worker + Web UI)
**Primary Dependencies**: Hono (API), React 18 + Vite (Web), Drizzle ORM (D1), Cloudflare Workers SDK (Durable Objects, Tail Workers)
**Storage**: Cloudflare D1 (new `OBSERVABILITY_DATABASE` for errors) + existing D1 (`DATABASE` for health queries) + Cloudflare Workers Observability API (historical logs, 7-day retention)
**Testing**: Vitest + Miniflare (API integration), Vitest (Web unit), Playwright (E2E)
**Target Platform**: Cloudflare Workers (API + Tail Worker), Cloudflare Pages (Web)
**Project Type**: Web application (monorepo: API Worker + Web UI + new Tail Worker)
**Performance Goals**: Error list <2s load, health summary <3s load, real-time stream <5s latency
**Constraints**: D1 row limits (50M writes/month on paid plan), CF Observability API rate limits, Tail Worker CPU time limits
**Scale/Scope**: Single admin user initially, up to 100K stored errors, moderate log volume

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| **I. Open Source Sustainability** | PASS | All functionality in OSS core, no enterprise separation needed |
| **II. Infrastructure Stability** | PASS | Error ingestion is fail-silent (never impacts existing error reporting behavior). Tests planned for all critical paths. |
| **III. Documentation Excellence** | PASS | API contracts documented, self-hosting guide will be updated |
| **IV. Approachable Code & UX** | PASS | Reuses existing UI patterns (LogEntry, Tabs, Section). Loading/error/empty states defined. |
| **VI. Automated Quality Gates** | PASS | Existing CI pipeline covers new code |
| **VIII. AI-Friendly Repository** | PASS | Consistent patterns with existing codebase |
| **IX. Clean Code Architecture** | PASS | Observability code in existing packages (api routes, web pages), new Tail Worker in apps/ |
| **X. Simplicity & Clarity** | PASS | Uses existing Cloudflare primitives (D1, DO, Tail Workers). No new external dependencies beyond CF ecosystem. |
| **XI. No Hardcoded Values** | PASS | All limits, timeouts, retention periods configurable via env vars (see data-model.md Configuration Variables) |
| **XII. Zero-to-Production Deployability** | PASS | New D1 database provisioned via Pulumi. Tail Worker deployed via Wrangler. Self-hosting docs updated. CF Observability API requires platform credentials (already documented). |

## Project Structure

### Documentation (this feature)

```text
specs/023-admin-observability/
├── plan.md                                  # This file
├── spec.md                                  # Feature specification
├── research.md                              # Phase 0 research decisions
├── data-model.md                            # Entity definitions, state machines, config vars
├── quickstart.md                            # Implementation quickstart
├── contracts/
│   └── admin-observability-api.md           # REST + WebSocket API contracts
├── checklists/
│   └── requirements.md                      # Spec quality checklist
└── tasks.md                                 # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
# API Worker (existing, extended)
apps/api/
├── src/
│   ├── routes/
│   │   └── admin.ts                         # MODIFIED: add observability sub-routes
│   ├── services/
│   │   ├── observability.ts                 # NEW: error CRUD, health aggregation, CF API proxy
│   │   └── observability-stream.ts          # NEW: AdminLogs DO service layer
│   ├── durable-objects/
│   │   └── admin-logs.ts                    # NEW: AdminLogs DO (WebSocket broadcasting)
│   ├── db/
│   │   ├── observability-schema.ts          # NEW: Drizzle schema for OBSERVABILITY_DATABASE
│   │   └── migrations/
│   │       └── observability/
│   │           └── 0000_init.sql            # NEW: platform_errors table
│   ├── lib/
│   │   └── logger.ts                        # MODIFIED: add optional D1 error capture
│   ├── scheduled/
│   │   └── observability-purge.ts           # NEW: error retention purge (cron job step)
│   └── index.ts                             # MODIFIED: Env interface + DO export + cron step
├── wrangler.toml                            # MODIFIED: OBSERVABILITY_DATABASE binding, tail_consumers
└── tests/
    └── integration/
        └── admin-observability.test.ts      # NEW: integration tests

# Tail Worker (new)
apps/tail-worker/
├── src/
│   └── index.ts                             # NEW: Tail handler → forward to AdminLogs DO
├── wrangler.toml                            # NEW: Tail Worker config
├── package.json                             # NEW: minimal deps
└── tsconfig.json                            # NEW

# Web UI (existing, extended)
apps/web/src/
├── pages/
│   └── Admin.tsx                            # MODIFIED: add tab navigation, observability tabs
├── components/
│   └── admin/
│       ├── AdminTabs.tsx                    # NEW: tab container (Users, Overview, Errors, Logs, Stream)
│       ├── HealthOverview.tsx               # NEW: health summary cards
│       ├── ErrorList.tsx                    # NEW: paginated error table with filters
│       ├── ErrorTrends.tsx                  # NEW: error trend chart
│       ├── LogViewer.tsx                    # NEW: historical log viewer (CF API proxy)
│       ├── LogStream.tsx                    # NEW: real-time log stream
│       ├── ObservabilityLogEntry.tsx        # NEW: log/error entry row (adapted from node LogEntry)
│       └── ObservabilityFilters.tsx         # NEW: filter controls (adapted from node LogFilters)
├── hooks/
│   ├── useAdminErrors.ts                   # NEW: error list fetching + pagination
│   ├── useAdminHealth.ts                   # NEW: health summary fetching
│   ├── useAdminLogQuery.ts                 # NEW: CF log query hook
│   └── useAdminLogStream.ts               # NEW: WebSocket log stream hook
└── lib/
    └── api.ts                               # MODIFIED: add admin observability API functions

# Infrastructure (existing, extended)
infra/
├── resources/
│   └── database.ts                          # MODIFIED: add observabilityDatabase resource
└── index.ts                                 # MODIFIED: export observability DB outputs

# Shared types (existing, extended)
packages/shared/src/
└── types/
    └── admin.ts                             # MODIFIED: add observability types

# Deploy scripts (existing, modified)
scripts/deploy/
├── sync-wrangler-config.ts                  # MODIFIED: sync both D1 bindings
└── run-migrations.ts                        # MODIFIED: run migrations for both databases
```

**Structure Decision**: Extends the existing monorepo structure. The only new deployable unit is `apps/tail-worker/` (a minimal Tail Worker). All other code goes into existing packages following established patterns. The AdminLogs DO lives in the API Worker (same as ProjectData and NodeLifecycle DOs).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| New Tail Worker (`apps/tail-worker/`) | Required for real-time log capture; Cloudflare Tail Workers must be separate Workers | Could poll Observability API instead, but this adds latency and wastes API quota; Tail Workers are the CF-native solution |
| Second D1 database (`OBSERVABILITY_DATABASE`) | Isolates error volume from core platform data; allows independent purge/reset | Same D1 table was rejected because error volume could impact core queries and couples operational concerns |
