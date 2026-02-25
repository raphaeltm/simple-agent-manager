# Tasks: Admin Observability Dashboard

**Input**: Design documents from `/specs/023-admin-observability/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/admin-observability-api.md, quickstart.md

**Tests**: Included (explicitly requested). Unit tests, integration tests (Miniflare), and E2E tests (Playwright) are required.

**Organization**: Tasks grouped by user story. Setup and Foundational phases first, then user stories in priority order (P1, P2, P3), then Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4, US5)
- Exact file paths included in every task description

## User Story Mapping

| Label | Story | Priority | Spec Ref |
|-------|-------|----------|----------|
| US1 | View Aggregated Platform Errors | P1 | FR-001–FR-004, FR-007–FR-009 |
| US2 | Platform Health Overview | P1 | FR-005–FR-006 |
| US3 | Historical API Worker Log Viewer | P2 | FR-010–FR-015 |
| US4 | Real-Time Log Stream | P2 | FR-016–FR-020 |
| US5 | Error Trend Visualization | P3 | FR-021–FR-022 |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Provision the new observability D1 database, add Env bindings, create the Drizzle schema, and set up the Tail Worker project skeleton.

- [x] T001 Add `observabilityDatabase` Pulumi resource in `infra/resources/database.ts` and export its ID/name from `infra/index.ts`
- [x] T002 Add `OBSERVABILITY_DATABASE` D1 binding to all environments in `apps/api/wrangler.toml` with `migrations_dir = "src/db/migrations/observability"`
- [x] T003 Add `OBSERVABILITY_DATABASE: D1Database` and `CF_ACCOUNT_ID: string` plus all 9 `OBSERVABILITY_*` config vars to the `Env` interface in `apps/api/src/index.ts`
- [x] T004 Create Drizzle schema for `platform_errors` table in `apps/api/src/db/observability-schema.ts` (fields: id, source, level, message, stack, context, userId, nodeId, workspaceId, ipAddress, userAgent, timestamp, createdAt; 4 indexes per data-model.md)
- [x] T005 Create D1 migration `apps/api/src/db/migrations/observability/0000_init.sql` matching the Drizzle schema (CREATE TABLE + CREATE INDEX statements)
- [x] T006 Update `scripts/deploy/sync-wrangler-config.ts` to sync `OBSERVABILITY_DATABASE` binding from Pulumi outputs alongside existing `DATABASE` binding
- [x] T007 Update `scripts/deploy/run-migrations.ts` to run migrations for both `DATABASE` and `OBSERVABILITY_DATABASE` directories
- [x] T008 [P] Create Tail Worker project skeleton: `apps/tail-worker/package.json`, `apps/tail-worker/tsconfig.json`, `apps/tail-worker/wrangler.toml`, `apps/tail-worker/src/index.ts` (empty tail handler export)
- [x] T009 [P] Add observability shared types to `packages/shared/src/types.ts`: `PlatformError`, `PlatformErrorSource`, `HealthSummary`, `ErrorTrendBucket`, `LogEntry`, `LogQueryParams`, `LogQueryResponse`, `ErrorListResponse`, `ErrorTrendResponse`, `LogStreamMessage` (all types per contracts/admin-observability-api.md)
- [x] T010 [P] Update `docs/guides/self-hosting.md` to document the new `OBSERVABILITY_DATABASE` D1 resource and `CF_ACCOUNT_ID` Worker secret requirement

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core service layer and error ingestion pipeline that ALL user stories depend on. Must complete before any story phase begins.

**CRITICAL**: No user story work can begin until this phase is complete.

### Tests for Foundational Phase

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T011 [P] Unit test for `persistError()` service in `apps/api/tests/unit/services/observability.test.ts` — test field validation, truncation (message 2048 chars, stack 4096 chars), source enum validation, batch size enforcement, and fail-silent behavior on D1 errors
- [x] T012 [P] Unit test for `queryErrors()` service in `apps/api/tests/unit/services/observability.test.ts` — test cursor-based pagination, filtering by source/level/search/timeRange, limit enforcement (max 200), and empty result handling
- [x] T013 [P] Unit test for error retention purge in `apps/api/tests/unit/services/observability-purge.test.ts` — test purge by age (`OBSERVABILITY_ERROR_RETENTION_DAYS`), purge by count (`OBSERVABILITY_ERROR_MAX_ROWS`), and combined purge logic
- [x] T014 [P] Unit test for modified client-errors route in `apps/api/tests/unit/routes/client-errors.test.ts` — add test cases verifying D1 write is attempted alongside console.error, and that D1 failure does not affect the 204 response
- [x] T015 [P] Unit test for modified vm-agent-errors route in `apps/api/tests/unit/routes/vm-agent-errors.test.ts` — add test cases verifying D1 write is attempted alongside console.error, and that D1 failure does not affect the 204 response
- [x] T016 [P] Unit test for logger D1 instrumentation in `apps/api/tests/unit/services/observability-logger.test.ts` — test that `log.error()` writes to D1 when db is provided, skips write when db is null, and never throws on D1 failure
- [x] T017 Integration test for error ingestion pipeline in `apps/api/tests/integration/observability-ingestion.test.ts` — test end-to-end: POST client error → verify D1 row, POST VM agent error → verify D1 row, trigger API error → verify D1 row, verify console.error still called for all three

### Implementation for Foundational Phase

- [x] T018 Implement `persistError()` and `persistErrorBatch()` functions in `apps/api/src/services/observability.ts` — accept error data, validate/truncate fields, insert into `OBSERVABILITY_DATABASE` via Drizzle, return void (fail-silent with console.warn on error)
- [x] T019 Implement `queryErrors()` function in `apps/api/src/services/observability.ts` — accept filter params (source, level, search, startTime, endTime, limit, cursor), build Drizzle query with cursor-based pagination, return `{ errors, cursor, hasMore, total }`
- [x] T020 Modify `apps/api/src/routes/client-errors.ts` to call `persistErrorBatch()` via `ctx.waitUntil()` after existing `console.error` calls, mapping client error fields to `PlatformError` shape with `source: 'client'`
- [x] T021 Modify `apps/api/src/routes/nodes.ts` (or the vm-agent error handler) to call `persistErrorBatch()` via `ctx.waitUntil()` after existing `console.error` calls, mapping VM agent error fields to `PlatformError` shape with `source: 'vm-agent'`
- [x] T022 Modify `apps/api/src/lib/logger.ts` to accept an optional `db` parameter and write error-level entries to `OBSERVABILITY_DATABASE` via `persistError()` with `source: 'api'`, using execution context `waitUntil()` when available
- [x] T023 Create `apps/api/src/scheduled/observability-purge.ts` implementing retention purge: delete rows older than `OBSERVABILITY_ERROR_RETENTION_DAYS` and delete oldest rows exceeding `OBSERVABILITY_ERROR_MAX_ROWS`
- [x] T024 Register the observability purge in `apps/api/src/index.ts` scheduled handler — call `purgeExpiredErrors()` after existing cron steps

**Checkpoint**: Error ingestion pipeline complete. Errors from all 3 sources persist to `OBSERVABILITY_DATABASE`. Purge runs every 5 min. All tests green.

---

## Phase 3: User Story 1 — View Aggregated Platform Errors (Priority: P1) MVP

**Goal**: Superadmin can view, filter, search, and paginate through all platform errors from a unified error list in the admin UI.

**Independent Test**: Trigger known errors from client, VM agent, and API. Navigate to admin observability errors tab. Verify all errors appear with correct source labels, timestamps, and context. Filter by source, level, time range, and search text.

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T025 [P] [US1] Unit test for admin observability error routes in `apps/api/tests/unit/routes/admin-observability.test.ts` — test `GET /api/admin/observability/errors`: auth enforcement (401/403), query param validation, pagination, filtering by source/level/search/time, empty results
- [x] T026 [P] [US1] Unit test for `ErrorList` component in `apps/web/tests/unit/components/admin/error-list.test.tsx` — test rendering error rows with source badges, filter controls, pagination, empty state, loading state, search input
- [x] T027 [P] [US1] Unit test for `useAdminErrors` hook in `apps/web/tests/unit/hooks/useAdminErrors.test.ts` — test fetch, pagination cursor management, filter state, error handling, loading states
- [x] T028 [P] [US1] Unit test for `ObservabilityLogEntry` component in `apps/web/tests/unit/components/admin/observability-log-entry.test.tsx` — test error entry rendering with expandable stack trace, context JSON, source color coding, timestamp formatting

### Implementation for User Story 1

- [x] T029 [US1] Add `GET /api/admin/observability/errors` route in `apps/api/src/routes/admin.ts` — create observability sub-router with `requireAuth() + requireApproved() + requireSuperadmin()` middleware chain, call `queryErrors()` service, return paginated response per contract
- [x] T030 [P] [US1] Add admin observability API functions to `apps/web/src/lib/api.ts` — `fetchAdminErrors(params)`, `fetchAdminHealth()`, `fetchAdminErrorTrends(params)`, `queryAdminLogs(params)` using existing `apiFetch` pattern
- [x] T031 [P] [US1] Create `useAdminErrors` hook in `apps/web/src/hooks/useAdminErrors.ts` — manage filter state (source, level, search, timeRange), pagination cursor, fetch via api.ts, expose loading/error/data states
- [x] T032 [US1] Create `ObservabilityLogEntry` component in `apps/web/src/components/admin/ObservabilityLogEntry.tsx` — render single error/log row with level badge (color-coded), source tag, message, expandable details (stack trace, context JSON), timestamp, user/node/workspace IDs when present
- [x] T033 [US1] Create `ObservabilityFilters` component in `apps/web/src/components/admin/ObservabilityFilters.tsx` — source dropdown (all/client/vm-agent/api), level dropdown (all/error/warn/info), time range selector (1h/24h/7d/30d/custom), search text input with debounce
- [x] T034 [US1] Create `ErrorList` component in `apps/web/src/components/admin/ErrorList.tsx` — compose `ObservabilityFilters` + paginated list of `ObservabilityLogEntry` items + cursor-based "Load More" button + empty state + loading skeleton
- [x] T035 [US1] Create `AdminTabs` component in `apps/web/src/components/admin/AdminTabs.tsx` — tab container with tabs: "Users" (existing admin content), "Overview" (US2), "Errors" (US1), "Logs" (US3), "Stream" (US4); use existing Tabs component pattern
- [x] T036 [US1] Refactor `apps/web/src/pages/Admin.tsx` to use `AdminTabs` — move existing user management content into the "Users" tab, add "Errors" tab rendering `ErrorList`, stub remaining tabs with placeholder content

**Checkpoint**: Admin can navigate to Admin > Errors tab, see paginated error list from all sources, filter/search, and view error details. Fully functional and testable independently.

---

## Phase 4: User Story 2 — Platform Health Overview (Priority: P1) MVP

**Goal**: Superadmin sees a dashboard with summary cards showing active nodes, workspaces, tasks, and 24h error count.

**Independent Test**: Verify health endpoint returns correct counts by comparing against known database state. Verify UI cards display the values with appropriate visual indicators (warning color on elevated error counts).

### Tests for User Story 2

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T037 [P] [US2] Unit test for `getHealthSummary()` service in `apps/api/tests/unit/services/observability-health.test.ts` — test correct count queries against both databases, handling of zero counts, timestamp accuracy
- [x] T038 [P] [US2] Unit test for health route in `apps/api/tests/unit/routes/admin-observability.test.ts` — test `GET /api/admin/observability/health`: auth enforcement, response shape, correct aggregation
- [x] T039 [P] [US2] Unit test for `HealthOverview` component in `apps/web/tests/unit/components/admin/health-overview.test.tsx` — test card rendering with correct labels/values, warning state on elevated errors, zero-value display, loading skeleton, error state

### Implementation for User Story 2

- [x] T040 [US2] Implement `getHealthSummary()` function in `apps/api/src/services/observability.ts` — query main `DATABASE` for active nodes/workspaces/tasks counts, query `OBSERVABILITY_DATABASE` for 24h error count, return `HealthSummary` object
- [x] T041 [US2] Add `GET /api/admin/observability/health` route in the observability sub-router in `apps/api/src/routes/admin.ts`
- [x] T042 [P] [US2] Create `useAdminHealth` hook in `apps/web/src/hooks/useAdminHealth.ts` — fetch health summary on mount, expose loading/error/data states, auto-refresh on configurable interval
- [x] T043 [US2] Create `HealthOverview` component in `apps/web/src/components/admin/HealthOverview.tsx` — four summary cards (Active Nodes, Active Workspaces, In-Progress Tasks, Errors 24h) with numeric values, warning color when error count exceeds configurable threshold, loading skeleton, empty state for zero values
- [x] T044 [US2] Wire `HealthOverview` into the "Overview" tab in `AdminTabs` (in `apps/web/src/components/admin/AdminTabs.tsx` or `apps/web/src/pages/Admin.tsx`)

**Checkpoint**: Admin can navigate to Admin > Overview tab, see 4 health summary cards with live data. Works independently of other stories.

---

## Phase 5: User Story 3 — Historical API Worker Log Viewer (Priority: P2)

**Goal**: Superadmin can query and browse historical API Worker logs from the Cloudflare Workers Observability API without leaving the admin UI.

**Independent Test**: Query the log viewer for a known time range, verify API Worker logs appear with correct timestamps, levels, and structured data. Test error handling when CF API is unavailable. Verify rate limiting works.

### Tests for User Story 3

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T045 [P] [US3] Unit test for CF Observability API proxy service in `apps/api/tests/unit/services/observability-logs.test.ts` — test request transformation to CF API format, response normalization, credential stripping, error handling (502 on CF failure), rate limit enforcement (429 response), search/filter/time range query building
- [x] T046 [P] [US3] Unit test for log query route in `apps/api/tests/unit/routes/admin-observability.test.ts` — test `POST /api/admin/observability/logs/query`: auth enforcement, request body validation, rate limiting headers, CF API error passthrough as 502
- [x] T047 [P] [US3] Unit test for `LogViewer` component in `apps/web/tests/unit/components/admin/log-viewer.test.tsx` — test log entry rendering, filter controls, pagination/load-more, loading state, error state (API unavailable message), empty state
- [x] T048 [P] [US3] Unit test for `useAdminLogQuery` hook in `apps/web/tests/unit/hooks/useAdminLogQuery.test.ts` — test query execution, cursor pagination, filter state management, rate limit error handling, loading states

### Implementation for User Story 3

- [x] T049 [US3] Implement `queryCloudflareeLogs()` function in `apps/api/src/services/observability.ts` — build CF Observability API request body from query params, call `POST /accounts/{CF_ACCOUNT_ID}/workers/observability/telemetry/query` using `fetch()` with `Authorization: Bearer ${CF_API_TOKEN}`, normalize response to `LogQueryResponse`, handle errors (502 for CF failures, never expose credentials)
- [x] T050 [US3] Implement per-admin rate limiting for CF log queries in `apps/api/src/services/observability.ts` — track query count per admin user ID using in-memory Map with sliding window, enforce `OBSERVABILITY_LOG_QUERY_RATE_LIMIT` (default 30/min), return 429 when exceeded
- [x] T051 [US3] Add `POST /api/admin/observability/logs/query` route in the observability sub-router in `apps/api/src/routes/admin.ts` — validate request body, call `queryCloudflareLogs()`, return normalized response
- [x] T052 [P] [US3] Create `useAdminLogQuery` hook in `apps/web/src/hooks/useAdminLogQuery.ts` — manage query params (timeRange, levels, search, cursor), trigger query via api.ts, handle pagination, expose loading/error/data/hasMore states
- [x] T053 [US3] Create `LogViewer` component in `apps/web/src/components/admin/LogViewer.tsx` — compose `ObservabilityFilters` (adapted for log levels + time range + search) + scrollable list of `ObservabilityLogEntry` items + cursor-based pagination + error banner for CF API failures + empty state
- [x] T054 [US3] Wire `LogViewer` into the "Logs" tab in `AdminTabs` (in `apps/web/src/components/admin/AdminTabs.tsx` or `apps/web/src/pages/Admin.tsx`)

**Checkpoint**: Admin can navigate to Admin > Logs tab, query historical API Worker logs with filters, paginate through results. CF API errors shown gracefully. Rate limiting prevents abuse.

---

## Phase 6: User Story 4 — Real-Time Log Stream (Priority: P2)

**Goal**: Superadmin can subscribe to a live WebSocket stream of platform logs with filtering, pause/resume, and connection status.

**Independent Test**: Open the stream tab, trigger API requests, verify log entries appear within 5 seconds. Test filter changes take effect immediately. Test pause/resume. Test reconnection after deliberate disconnect.

### Tests for User Story 4

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T055 [P] [US4] Unit test for AdminLogs DO in `apps/api/tests/unit/durable-objects/admin-logs.test.ts` — test WebSocket accept, broadcast to multiple clients, filter message handling (per-client filters), pause/resume per client, ping/pong, client disconnect cleanup, event forwarding from Tail Worker fetch
- [x] T056 [P] [US4] Unit test for Tail Worker handler in `apps/tail-worker/tests/unit/tail-handler.test.ts` — test `tail()` function with mock `TraceItem[]` data: filters for error/warn/info levels, batches events, calls AdminLogs DO via fetch, handles DO fetch failures gracefully (NOTE: tail_consumers cannot be tested with Miniflare, must use mock data)
- [x] T057 [P] [US4] Unit test for stream WebSocket upgrade route in `apps/api/tests/unit/routes/admin-observability.test.ts` — test `GET /api/admin/observability/logs/stream`: auth enforcement on upgrade, DO stub forwarding, non-WebSocket request rejection
- [x] T058 [P] [US4] Unit test for `LogStream` component in `apps/web/tests/unit/components/admin/log-stream.test.tsx` — test connection status indicator (connected/reconnecting/disconnected), log entry rendering, pause/resume button, filter controls, auto-scroll behavior, buffer size limit
- [x] T059 [P] [US4] Unit test for `useAdminLogStream` hook in `apps/web/tests/unit/hooks/useAdminLogStream.test.ts` — test WebSocket connection lifecycle, message parsing, filter message sending, pause/resume state, reconnection with exponential backoff, buffer management during pause
- [x] T060 [P] [US4] Workers integration test for AdminLogs DO in `apps/api/tests/workers/admin-logs-do.test.ts` — test real DO with Miniflare: WebSocket upgrade, event broadcast, multi-client filtering (uses `@cloudflare/vitest-pool-workers` with `isolatedStorage: false` per existing project-data-do.test.ts pattern)

### Implementation for User Story 4

- [x] T061 [US4] Create `AdminLogs` Durable Object in `apps/api/src/durable-objects/admin-logs.ts` — hibernatable WebSocket API (same pattern as `ProjectData`): accept WebSocket on fetch, store per-client filter state via `ws.serializeAttachment()`, handle incoming messages (ping/pong, filter, pause, resume), broadcast log events to connected clients with server-side filtering, handle `webSocketClose`/`webSocketError` for cleanup
- [x] T062 [US4] Register `AdminLogs` DO: add binding to `Env` interface (`ADMIN_LOGS: DurableObjectNamespace`), add `[[durable_objects.bindings]]` in `apps/api/wrangler.toml` for all environments, add DO migration entry, export class from `apps/api/src/index.ts`
- [x] T063 [US4] Add `GET /api/admin/observability/logs/stream` WebSocket upgrade route in `apps/api/src/routes/admin.ts` — validate auth on HTTP request, get AdminLogs DO singleton stub via `env.ADMIN_LOGS.idFromName('admin-logs')`, forward request to DO for WebSocket upgrade
- [x] T064 [US4] Implement Tail Worker handler in `apps/tail-worker/src/index.ts` — export `tail(events: TraceItem[])` that filters for log-level events (error/warn/info), maps to `LogStreamMessage` format, POSTs batched events to AdminLogs DO via service binding or fetch URL
- [x] T065 [US4] Configure `tail_consumers` in `apps/api/wrangler.toml` for staging and production environments ONLY (NOT in default/dev config, as tail_consumers breaks Vitest — see Cloudflare issue #9343), pointing to the Tail Worker service name
- [x] T066 [P] [US4] Create `useAdminLogStream` hook in `apps/web/src/hooks/useAdminLogStream.ts` — manage WebSocket connection to `/api/admin/observability/logs/stream`, parse incoming messages, maintain log entry buffer (max `OBSERVABILITY_STREAM_BUFFER_SIZE`), send filter/pause/resume messages, implement reconnection with exponential backoff (`OBSERVABILITY_STREAM_RECONNECT_DELAY_MS` to `OBSERVABILITY_STREAM_RECONNECT_MAX_DELAY_MS`)
- [x] T067 [US4] Create `LogStream` component in `apps/web/src/components/admin/LogStream.tsx` — connection status badge (connected green/reconnecting yellow/disconnected red), severity filter controls, pause/resume toggle button, auto-scrolling log entry list using `ObservabilityLogEntry`, entry count indicator
- [x] T068 [US4] Wire `LogStream` into the "Stream" tab in `AdminTabs` (in `apps/web/src/components/admin/AdminTabs.tsx` or `apps/web/src/pages/Admin.tsx`)

**Checkpoint**: Admin can navigate to Admin > Stream tab, see live log entries arriving via WebSocket, filter by severity, pause/resume, and see connection status. Auto-reconnects on disconnect.

---

## Phase 7: User Story 5 — Error Trend Visualization (Priority: P3)

**Goal**: Superadmin can view error counts over time grouped by source, with adjustable time ranges.

**Independent Test**: Generate errors at known times, verify the trend chart correctly plots them over the selected time window with correct source breakdown.

### Tests for User Story 5

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T069 [P] [US5] Unit test for `getErrorTrends()` service in `apps/api/tests/unit/services/observability-trends.test.ts` — test time bucketing (5m/1h/1d intervals), source grouping, auto-interval selection from range, empty bucket handling, boundary conditions
- [x] T070 [P] [US5] Unit test for trends route in `apps/api/tests/unit/routes/admin-observability.test.ts` — test `GET /api/admin/observability/errors/trends`: auth enforcement, query param validation (range, interval), response shape per contract
- [x] T071 [P] [US5] Unit test for `ErrorTrends` component in `apps/web/tests/unit/components/admin/error-trends.test.tsx` — test chart rendering with source breakdown, time range selector, empty state, loading state, data update on range change

### Implementation for User Story 5

- [x] T072 [US5] Implement `getErrorTrends()` function in `apps/api/src/services/observability.ts` — query `OBSERVABILITY_DATABASE` with GROUP BY time bucket and source, apply auto-interval mapping (1h→5m, 24h→1h, 7d→1d, 30d→1d), return `ErrorTrendResponse` with `{ range, interval, buckets }` per contract
- [x] T073 [US5] Add `GET /api/admin/observability/errors/trends` route in the observability sub-router in `apps/api/src/routes/admin.ts` — validate range/interval params, call `getErrorTrends()`, return response
- [x] T074 [P] [US5] Create `ErrorTrends` component in `apps/web/src/components/admin/ErrorTrends.tsx` — time range selector buttons (1h/24h/7d/30d), stacked bar chart or area chart showing error counts by source (client=blue, vm-agent=orange, api=red) per time bucket, responsive sizing, empty state
- [x] T075 [US5] Wire `ErrorTrends` into the "Overview" tab below `HealthOverview` in `apps/web/src/pages/Admin.tsx` or `apps/web/src/components/admin/AdminTabs.tsx` — trends chart appears below the health summary cards

**Checkpoint**: Admin sees error trend chart on the Overview tab with source-colored bars/areas over time. Changing time range updates the chart.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: E2E tests, documentation sync, deploy script validation, and final quality pass.

- [x] T076 [P] E2E test: admin observability errors flow in `apps/web/tests/e2e/admin-observability.spec.ts` — Playwright test: login as superadmin, navigate to Admin page, verify tabs render, switch to Errors tab, verify error list loads, apply filter, verify filtered results, paginate
- [x] T077 [P] E2E test: admin health overview in `apps/web/tests/e2e/admin-observability.spec.ts` — Playwright test: navigate to Overview tab, verify 4 health cards render with numeric values, verify error trends chart renders
- [x] T078 [P] E2E test: admin log viewer in `apps/web/tests/e2e/admin-observability.spec.ts` — Playwright test: navigate to Logs tab, verify log entries load from CF API proxy, apply level filter, verify filter takes effect
- [x] T079 [P] E2E test: admin log stream in `apps/web/tests/e2e/admin-observability.spec.ts` — Playwright test: navigate to Stream tab, verify connection status shows "Connected", verify pause/resume button works
- [x] T080 Update `CLAUDE.md` Active Technologies section to include Tail Workers and OBSERVABILITY_DATABASE
- [x] T081 Update `apps/api/.env.example` with new env vars: `CF_ACCOUNT_ID`, all `OBSERVABILITY_*` config vars with default values and comments
- [x] T082 [P] Verify CI pipeline runs all new tests: run `pnpm test` from repo root, confirm unit tests pass; run `pnpm test:workers` for DO integration tests; confirm no regressions
- [x] T083 Run `pnpm lint && pnpm typecheck && pnpm build` from repo root — fix any errors across all packages
- [x] T084 Run quickstart.md validation — verify each phase's "Verify" step can be executed against staging deployment

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — BLOCKS all user stories
- **US1 Errors (Phase 3)**: Depends on Phase 2 (needs error ingestion pipeline + queryErrors service)
- **US2 Health (Phase 4)**: Depends on Phase 2 (needs observability DB for error count). Can run in parallel with US1.
- **US3 Log Viewer (Phase 5)**: Depends on Phase 2 (needs Env with CF_ACCOUNT_ID). Can run in parallel with US1/US2.
- **US4 Stream (Phase 6)**: Depends on Phase 2 (needs AdminLogs DO registered). Can run in parallel with US1/US2/US3.
- **US5 Trends (Phase 7)**: Depends on Phase 2 (needs error data in D1). Depends on US2 Phase 4 for UI placement (trends chart goes on Overview tab below health cards). Can run API-side in parallel with US1/US2.
- **Polish (Phase 8)**: Depends on all story phases being complete

### User Story Dependencies

- **US1 (P1)**: Foundational → US1 (no other story deps)
- **US2 (P1)**: Foundational → US2 (no other story deps)
- **US3 (P2)**: Foundational → US3 (no other story deps)
- **US4 (P2)**: Foundational → US4 (no other story deps)
- **US5 (P3)**: Foundational → US5 (UI depends on US2's Overview tab being built first for placement)

### Within Each User Story

1. Tests MUST be written and FAIL before implementation
2. Service/API layer before UI components
3. Hooks before components that use them
4. Components before page-level wiring
5. Story complete before moving to next priority

### Parallel Opportunities

- All Phase 1 tasks T008, T009, T010 can run in parallel with T001-T007
- All foundational test tasks (T011-T017) can run in parallel
- All US1-US4 story phases can start in parallel after Phase 2 (different files, different concerns)
- Within each story: test tasks marked [P] can run in parallel; implementation tasks marked [P] can run in parallel
- US5 API-side (T069-T073) can run in parallel with US1-US4; UI-side (T074-T075) depends on US2's Overview tab

---

## Parallel Example: Phase 2 Foundational

```bash
# Launch all foundational tests in parallel (all different files):
Task: "Unit test for persistError() service in apps/api/tests/unit/services/observability.test.ts"
Task: "Unit test for queryErrors() service in apps/api/tests/unit/services/observability.test.ts"
Task: "Unit test for error retention purge in apps/api/tests/unit/services/observability-purge.test.ts"
Task: "Unit test for modified client-errors route in apps/api/tests/unit/routes/client-errors.test.ts"
Task: "Unit test for modified vm-agent-errors route in apps/api/tests/unit/routes/vm-agent-errors.test.ts"
Task: "Unit test for logger D1 instrumentation in apps/api/tests/unit/services/observability-logger.test.ts"
```

## Parallel Example: User Stories After Phase 2

```bash
# Launch all P1 stories in parallel:
Task: "US1 — Error List (Phase 3)" — Developer A
Task: "US2 — Health Overview (Phase 4)" — Developer B

# Or launch all stories at once (different files per story):
Task: "US1 — Error List" — touches ErrorList.tsx, useAdminErrors.ts
Task: "US2 — Health Overview" — touches HealthOverview.tsx, useAdminHealth.ts
Task: "US3 — Log Viewer" — touches LogViewer.tsx, useAdminLogQuery.ts
Task: "US4 — Stream" — touches LogStream.tsx, useAdminLogStream.ts, admin-logs.ts, tail-worker/
```

---

## Implementation Strategy

### MVP First (US1 + US2 Only)

1. Complete Phase 1: Setup (T001-T010)
2. Complete Phase 2: Foundational (T011-T024)
3. Complete Phase 3: US1 — Error List (T025-T036)
4. Complete Phase 4: US2 — Health Overview (T037-T044)
5. **STOP and VALIDATE**: Test error list + health overview independently
6. Deploy/demo if ready — admin can see errors and health metrics

### Incremental Delivery

1. Setup + Foundational → Error ingestion pipeline live
2. Add US1 (Error List) → Deploy → Admin can browse all errors (MVP!)
3. Add US2 (Health Overview) → Deploy → Admin gets at-a-glance health
4. Add US3 (Log Viewer) → Deploy → Admin can query CF logs in-app
5. Add US4 (Real-Time Stream) → Deploy → Admin gets live log feed
6. Add US5 (Error Trends) → Deploy → Admin sees trend visualization
7. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: US1 (Error List) + US5 (Trends — shares Overview tab)
   - Developer B: US2 (Health Overview) + US3 (Log Viewer)
   - Developer C: US4 (Real-Time Stream — most isolated)
3. Stories complete and integrate independently

### Testing Strategy Summary

| Layer | Tool | Location | CI? |
|-------|------|----------|-----|
| Unit (API services) | Vitest | `apps/api/tests/unit/services/` | Yes (`pnpm test`) |
| Unit (API routes) | Vitest + Hono mock | `apps/api/tests/unit/routes/` | Yes (`pnpm test`) |
| Unit (Web components) | Vitest + React Testing Library | `apps/web/tests/unit/components/admin/` | Yes (`pnpm test`) |
| Unit (Web hooks) | Vitest | `apps/web/tests/unit/hooks/` | Yes (`pnpm test`) |
| Unit (Tail Worker) | Vitest + mock TraceItem[] | `apps/tail-worker/tests/unit/` | Yes (`pnpm test`) |
| Workers Integration (DO) | @cloudflare/vitest-pool-workers | `apps/api/tests/workers/` | Separate (`pnpm test:workers`) |
| Integration (pipeline) | Vitest + in-memory D1 mock | `apps/api/tests/integration/` | Yes (`pnpm test`) |
| E2E | Playwright | `apps/web/tests/e2e/` | Post-deploy manual |

### Key Testing Notes

- **Tail Workers cannot be tested with Miniflare** (`tail_consumers` in wrangler.toml breaks all Vitest — Cloudflare issue #9343). Keep `tail_consumers` out of dev/test wrangler config. Test the `tail()` handler directly with mock `TraceItem[]` arrays.
- **AdminLogs DO integration tests** must use `isolatedStorage: false` (same as existing `project-data-do.test.ts`) because hibernatable WebSocket DOs require shared storage.
- **@cloudflare/vitest-pool-workers** is at `^0.5.0` in the project — consider upgrading to `0.12.x` for Vitest 3.x compatibility if upgrading Vitest.
- **Rate limiting tests** for the CF log proxy use in-memory state, so tests should verify the sliding window resets correctly.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Write tests first, verify they fail, then implement
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- `tail_consumers` MUST NOT be in default wrangler config (only staging/production) to avoid breaking tests
- All `OBSERVABILITY_*` env vars must have sensible defaults per Constitution Principle XI
- CF_ACCOUNT_ID is a new required Worker secret for the log viewer (US3)
