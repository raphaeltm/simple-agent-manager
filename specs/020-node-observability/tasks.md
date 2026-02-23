# Tasks: Node-Level Observability & Log Aggregation

**Input**: Design documents from `/specs/020-node-observability/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested in the feature specification. Tests are included where critical paths require validation (Docker fix, log reader, slog migration) per constitution principle II (Infrastructure Stability).

**Organization**: Tasks grouped by user story to enable independent implementation and testing. User Stories 1 and 2 are both P1 priority. Stories 3-5 build incrementally.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Exact file paths included in descriptions

## Path Conventions

- **VM Agent (Go)**: `packages/vm-agent/`
- **Shared types**: `packages/shared/src/`
- **Cloud-init**: `packages/cloud-init/src/`
- **API Worker**: `apps/api/src/`
- **Web UI**: `apps/web/src/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add shared types and configure logging infrastructure that all stories depend on

- [x] T001 Add `NodeLogEntry`, `NodeLogSource`, `NodeLogLevel`, `NodeLogFilter`, `NodeLogResponse` types to `packages/shared/src/types.ts`
- [x] T002 [P] Add `ContainerState` type and update `ContainerInfo` with `state`, `cpuPercent`, `memUsage`, `memPercent`, `createdAt` fields in `packages/shared/src/types.ts`
- [x] T003 [P] Add `DockerInfoWithError` type (add optional `error` field to DockerInfo) in `packages/shared/src/types.ts`
- [x] T004 [P] Export new types from `packages/shared/src/index.ts`
- [x] T005 Build shared package: `pnpm --filter @simple-agent-manager/shared build`

---

## Phase 2: Foundational — Structured Logging Migration (Blocking Prerequisite)

**Purpose**: Migrate VM agent from `log` to `log/slog` with structured JSON output. This is foundational because all subsequent log collection depends on the agent producing structured logs via journald.

**⚠️ CRITICAL**: Log collection (US1) and Docker fix (US2) depend on structured logging being in place. Complete this phase before starting user stories.

- [x] T006 Create `packages/vm-agent/internal/logging/setup.go` — slog configuration with `slog.NewJSONHandler`, `slog.LevelVar` for runtime level changes, `LOG_LEVEL` and `LOG_FORMAT` env var support
- [x] T007 [P] Create `packages/vm-agent/internal/logging/setup_test.go` — test slog setup, level parsing, format selection, LevelVar runtime changes
- [x] T008 Update `packages/vm-agent/main.go` — replace `log.SetFlags()` init with `logging.Setup()`, set `slog.SetDefault()`, bridge stdlib `log` to slog via `slog.NewLogLogger()`
- [x] T009 Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/server/` to `slog.Info`/`slog.Error`/`slog.Warn` with structured key-value pairs
- [x] T010 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/sysinfo/` to structured slog calls
- [x] T011 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/idle/` to structured slog calls
- [x] T012 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/pty/` to structured slog calls
- [x] T013 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/bootstrap/` to structured slog calls
- [x] T014 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/container/` to structured slog calls
- [x] T015 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/auth/` to structured slog calls
- [x] T016 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/bootlog/` to structured slog calls
- [x] T017 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/config/` to structured slog calls
- [x] T018 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/errorreport/` to structured slog calls
- [x] T019 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/persistence/` to structured slog calls
- [x] T020 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/agentsessions/` to structured slog calls
- [x] T021 [P] Migrate all `log.Printf`/`log.Println` calls in `packages/vm-agent/internal/acp/` to structured slog calls
- [x] T022 Remove `import "log"` from all migrated files (replace with `"log/slog"`) and verify no unstructured log calls remain
- [x] T023 Run `go test ./...` in `packages/vm-agent/` — ensure all existing tests pass with slog migration

**Checkpoint**: VM agent produces structured JSON logs via slog. All existing functionality preserved. Ready for log collection.

---

## Phase 3: User Story 2 — Docker Container Listing Fix (Priority: P1) 🎯 MVP

**Goal**: Fix the broken Docker container listing so it accurately shows all containers and surfaces errors instead of silently failing.

**Independent Test**: Create a node, provision a workspace with a devcontainer, navigate to the node info page and verify containers appear with accurate status. Also verify that when Docker is unreachable, an error message is shown instead of "No running containers."

**Why US2 before US1**: The Docker fix is a smaller, self-contained bug fix (FR-012 through FR-015). Completing it first provides immediate value and unblocks the Docker log source in US1/US4.

### Implementation for User Story 2

- [x] T024 [US2] Refactor `packages/vm-agent/internal/sysinfo/sysinfo.go` — replace `docker stats --no-stream` with `docker ps -a --format '{{json .}}'` for container enumeration; keep `docker stats --no-stream` only for resource metrics of running containers
- [x] T025 [US2] Add `SYSINFO_DOCKER_LIST_TIMEOUT` and `SYSINFO_DOCKER_STATS_TIMEOUT` configurable env vars with defaults (`10s`) in `packages/vm-agent/internal/sysinfo/sysinfo.go`
- [x] T026 [US2] Add `error` field to Docker info response in `packages/vm-agent/internal/sysinfo/sysinfo.go` — surface Docker query failures instead of swallowing errors
- [x] T027 [US2] Parse `docker ps -a` JSON output into updated `ContainerInfo` struct with `state`, `cpuPercent`, `memUsage`, `memPercent`, `createdAt` fields in `packages/vm-agent/internal/sysinfo/sysinfo.go`
- [x] T028 [US2] Update `packages/vm-agent/internal/sysinfo/sysinfo_test.go` — test `docker ps -a` parsing, error state surfacing, stats-only-for-running logic, timeout behavior
- [x] T029 [US2] Update `apps/web/src/components/node/DockerSection.tsx` — handle `error` field: distinguish "no containers" vs "query failed" states (FR-015)
- [x] T030 [US2] Update `apps/web/src/hooks/useNodeSystemInfo.ts` — handle Docker error state in the system info response

**Checkpoint**: Docker section accurately shows all containers in all states. Error states are surfaced to user. "No running containers" only shown when truly no containers exist.

---

## Phase 4: User Story 1 — Diagnose Overnight Agent Failures (Priority: P1) 🎯 MVP

**Goal**: Users can view all node logs from the control plane with filtering by source and level, plus real-time streaming — without needing SSH.

**Independent Test**: Create a node with a running workspace, trigger an error (e.g., restart Docker), navigate to node info page and verify the error appears in the log viewer with timestamp, source, level, and message.

### Implementation for User Story 1

#### VM Agent: Log Reader

- [x] T031 [US1] Create `packages/vm-agent/internal/logreader/reader.go` — implement `ReadLogs(filter LogFilter) (LogResponse, error)` using `journalctl --output=json` for agent and systemd sources, with cursor-based pagination
- [x] T032 [US1] Add cloud-init file reading to `packages/vm-agent/internal/logreader/reader.go` — parse `/var/log/cloud-init.log` and `/var/log/cloud-init-output.log`, merge into unified timeline by timestamp
- [x] T033 [US1] Add Docker container log reading to `packages/vm-agent/internal/logreader/reader.go` — query journald with `CONTAINER_NAME` field filter for Docker source
- [x] T034 [US1] Add `LOG_RETRIEVAL_DEFAULT_LIMIT` (200) and `LOG_RETRIEVAL_MAX_LIMIT` (1000) configurable env vars in `packages/vm-agent/internal/logreader/reader.go`
- [x] T035 [P] [US1] Create `packages/vm-agent/internal/logreader/reader_test.go` — test journalctl output parsing, cloud-init file parsing, Docker log merging, filter logic, pagination cursors, limit clamping

#### VM Agent: Log Streaming

- [x] T036 [US1] Create `packages/vm-agent/internal/logreader/stream.go` — implement `StreamLogs(filter, sendFunc)` using `journalctl --follow --output=json` with catch-up buffer (`LOG_STREAM_BUFFER_SIZE` env var, default 100)
- [x] T037 [P] [US1] Create `packages/vm-agent/internal/logreader/stream_test.go` — test streaming startup, filter application, catch-up delivery, process restart on failure

#### VM Agent: HTTP Handlers

- [x] T038 [US1] Create `packages/vm-agent/internal/server/logs.go` — implement `GET /logs` handler using `logreader.ReadLogs()`, parse query params into `LogFilter`, return JSON `LogResponse`
- [x] T039 [US1] Add `GET /logs/stream` WebSocket handler in `packages/vm-agent/internal/server/logs.go` — authenticate via `?token=` query param, parse filters, catch-up then stream via `logreader.StreamLogs()`, ping/pong heartbeat (30s ping, 90s timeout)
- [x] T040 [US1] Register `/logs` and `/logs/stream` routes in `packages/vm-agent/internal/server/server.go` with `requireNodeEventAuth` middleware
- [x] T041 [P] [US1] Create `packages/vm-agent/internal/server/logs_test.go` — test HTTP handler param parsing, response format, auth enforcement, error responses

#### Control Plane: Proxy Endpoints

- [x] T042 [US1] Add `getNodeLogsFromNode()` function in `apps/api/src/services/node-agent.ts` — proxy to VM agent `GET /logs` using existing `nodeAgentRequest()` pattern
- [x] T043 [US1] Add `GET /api/nodes/:nodeId/logs` route in `apps/api/src/routes/nodes.ts` — authenticate user, verify node ownership, pass through query params, call `getNodeLogsFromNode()`
- [x] T044 [US1] Add `GET /api/nodes/:nodeId/logs/stream` WebSocket proxy route in `apps/api/src/routes/nodes.ts` — authenticate, verify ownership, proxy WebSocket to VM agent with management JWT

#### Web UI: Log Viewer

- [x] T045 [US1] Create `apps/web/src/hooks/useNodeLogs.ts` — implement log fetching (initial load + pagination via cursor), filter state management, WebSocket streaming connection with reconnect logic, pause/resume support
- [x] T046 [US1] Create `apps/web/src/components/node/LogEntry.tsx` — single log entry display with severity-based color coding (error=red, warn=yellow, info=default, debug=gray), timestamp, source badge, message text, expandable metadata
- [x] T047 [US1] Create `apps/web/src/components/node/LogFilters.tsx` — filter controls: source dropdown (all/agent/cloud-init/docker/systemd), level dropdown (debug/info/warn/error), optional container name input, time range selector
- [x] T048 [US1] Create `apps/web/src/components/node/LogsSection.tsx` — main log viewer component: integrate LogFilters, virtualized list of LogEntry components (10,000+ entries), streaming status indicator, pause/resume button, auto-scroll with user override, loading and error states, disconnection banner with retry
- [x] T049 [US1] Add LogsSection to `apps/web/src/pages/Node.tsx` — render below existing sections, pass nodeId

**Checkpoint**: Users can view all agent logs, filter by source and level, see real-time streaming, pause/resume stream, and diagnose overnight failures without SSH.

---

## Phase 5: User Story 3 — Cloud-Init Provisioning Logs (Priority: P2)

**Goal**: Users can view cloud-init provisioning logs to diagnose setup failures.

**Independent Test**: Create a new node, wait for provisioning, navigate to node info page, filter to "cloud-init" source, and verify provisioning output is visible including any errors.

### Implementation for User Story 3

- [x] T050 [US3] Update `packages/cloud-init/src/template.ts` — add journald configuration to cloud-init template: `/etc/systemd/journald.conf` with `SystemMaxUse=${LOG_JOURNAL_MAX_USE}`, `SystemKeepFree=${LOG_JOURNAL_KEEP_FREE}`, `MaxRetentionSec=${LOG_JOURNAL_MAX_RETENTION}`, `Storage=persistent`, `Compress=yes`
- [x] T051 [US3] Update `packages/cloud-init/src/template.ts` — add Docker journald logging driver configuration: write `/etc/docker/daemon.json` with `{"log-driver": "journald", "log-opts": {"tag": "docker/{{.Name}}"}}`
- [x] T052 [US3] Ensure cloud-init log parsing in `packages/vm-agent/internal/logreader/reader.go` handles both `/var/log/cloud-init.log` (structured with timestamps/levels) and `/var/log/cloud-init-output.log` (raw command output, assign INFO level)
- [x] T053 [US3] Build cloud-init package: `pnpm --filter @simple-agent-manager/cloud-init build`

**Checkpoint**: Cloud-init logs visible in log viewer. New nodes get journald size limits and Docker journald driver configured automatically.

---

## Phase 6: User Story 4 — Docker Container Logs (Priority: P2)

**Goal**: Users can view stdout/stderr from individual Docker containers to debug application-level issues.

**Independent Test**: Create a workspace with a devcontainer that produces output, navigate to node info page, filter logs to that container name, and verify the container output is visible.

### Implementation for User Story 4

- [x] T054 [US4] Ensure Docker container log entries in `packages/vm-agent/internal/logreader/reader.go` use source format `docker:<container-name>` parsed from journald `CONTAINER_NAME` field
- [x] T055 [US4] Add container name filter support to `packages/vm-agent/internal/logreader/reader.go` — when `container` param is set, filter journald query to `CONTAINER_NAME=<value>`
- [x] T056 [US4] Add container name filter support to `packages/vm-agent/internal/logreader/stream.go` — pass container filter to `journalctl --follow` command
- [x] T057 [US4] Update `apps/web/src/components/node/LogFilters.tsx` — add container name input field, populate container name suggestions from Docker section data if available

**Checkpoint**: Users can filter logs to specific containers and see individual container stdout/stderr.

---

## Phase 7: User Story 5 — Search and Navigate Logs (Priority: P3)

**Goal**: Users can search through logs using keywords to find specific events without manual scrolling.

**Independent Test**: Accumulate logs on a node, use search to find a specific error message, verify it highlights matching entries and shows match count.

### Implementation for User Story 5

- [x] T058 [US5] Add `search` parameter support to `packages/vm-agent/internal/logreader/reader.go` — case-insensitive substring match on message field, apply after other filters
- [x] T059 [US5] Add search input to `apps/web/src/components/node/LogFilters.tsx` — debounced text input that triggers log re-fetch with `search` param
- [x] T060 [US5] Add search highlighting to `apps/web/src/components/node/LogEntry.tsx` — highlight matching substring within message text
- [x] T061 [US5] Add match count display to `apps/web/src/components/node/LogsSection.tsx` — show "N matches found" when search is active

**Checkpoint**: Users can search logs by keyword, see match count, and highlighted results. Search composes with source and level filters.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation updates, build verification, and cleanup

- [x] T062 [P] Update `CLAUDE.md` — add `log/slog` to Active Technologies for VM agent, add journald to storage technologies
- [x] T063 [P] Update `docs/guides/self-hosting.md` — add journald configuration section, document `LOG_*` env vars for VM agent
- [x] T064 [P] Run full build in dependency order: shared → cloud-init → vm-agent → api → web
- [x] T065 [P] Run `pnpm typecheck` from repo root — verify no type errors across all packages
- [x] T066 [P] Run `pnpm lint` from repo root — verify no lint errors
- [x] T067 Run quickstart.md validation — follow quickstart steps end-to-end to verify build and dev workflow

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational — slog migration)**: Depends on Phase 1 (shared types built)
- **Phase 3 (US2 — Docker fix)**: Depends on Phase 1 (shared types) + Phase 2 (slog in sysinfo)
- **Phase 4 (US1 — Log viewer)**: Depends on Phase 2 (structured logs flowing through journald)
- **Phase 5 (US3 — Cloud-init logs)**: Depends on Phase 4 (log reader exists to serve cloud-init logs)
- **Phase 6 (US4 — Container logs)**: Depends on Phase 4 (log reader) + Phase 5 (Docker journald driver configured)
- **Phase 7 (US5 — Search)**: Depends on Phase 4 (log viewer UI exists to add search to)
- **Phase 8 (Polish)**: Depends on all prior phases

### User Story Dependencies

- **US2 (Docker fix, P1)**: Independent after foundational phase — can start immediately after Phase 2
- **US1 (Log viewer, P1)**: Independent after foundational phase — can run in parallel with US2
- **US3 (Cloud-init, P2)**: Depends on US1 (log reader infrastructure) — extend existing reader
- **US4 (Container logs, P2)**: Depends on US1 (log reader) + US3 (Docker journald driver from cloud-init update)
- **US5 (Search, P3)**: Depends on US1 (log viewer UI) — adds search to existing viewer

### Within Each User Story

- VM agent changes before API proxy changes
- API proxy changes before web UI changes
- Reader before streamer (for US1)
- Core implementation before integration

### Parallel Opportunities

**Phase 1**: T002, T003, T004 can all run in parallel (different type additions)
**Phase 2**: T010-T021 can all run in parallel (different files, same slog migration pattern)
**Phase 3 (US2)**: Independent from US1 — can run in parallel with Phase 4
**Phase 4 (US1)**: T035/T037/T041 (tests) can run in parallel with each other; T046/T047 (UI components) can run in parallel
**Phase 8**: T062-T066 can all run in parallel

---

## Parallel Example: Phase 2 — slog Migration

```text
# All slog migration tasks in parallel (different packages, same pattern):
T010: Migrate sysinfo/ to slog
T011: Migrate idle/ to slog
T012: Migrate pty/ to slog
T013: Migrate bootstrap/ to slog
T014: Migrate container/ to slog
T015: Migrate auth/ to slog
T016: Migrate bootlog/ to slog
T017: Migrate config/ to slog
T018: Migrate errorreport/ to slog
T019: Migrate persistence/ to slog
T020: Migrate agentsessions/ to slog
T021: Migrate acp/ to slog
```

## Parallel Example: Phase 4 — US1 UI Components

```text
# Log viewer UI components in parallel (different files):
T046: Create LogEntry.tsx
T047: Create LogFilters.tsx

# Then sequentially:
T048: Create LogsSection.tsx (depends on T046, T047)
T049: Add to Node.tsx (depends on T048)
```

---

## Implementation Strategy

### MVP First (US2 + US1 Only)

1. Complete Phase 1: Shared types (T001-T005)
2. Complete Phase 2: slog migration (T006-T023)
3. Complete Phase 3: Docker fix — US2 (T024-T030)
4. Complete Phase 4: Log viewer — US1 (T031-T049)
5. **STOP and VALIDATE**: Test both stories independently
6. Deploy to staging and verify

### Incremental Delivery

1. Phase 1 + 2 → Foundation ready (structured logging, shared types)
2. Add US2 (Docker fix) → Test independently → **Immediate user value**
3. Add US1 (Log viewer) → Test independently → **Core observability MVP**
4. Add US3 (Cloud-init) → Extends log viewer to provisioning logs
5. Add US4 (Container logs) → Extends log viewer to Docker container output
6. Add US5 (Search) → Quality-of-life improvement for log navigation
7. Phase 8 (Polish) → Docs, build verification, cleanup

### Suggested MVP Scope

**MVP = Phase 1 + Phase 2 + Phase 3 (US2) + Phase 4 (US1)**

This delivers:
- Structured logging throughout VM agent (foundation)
- Fixed Docker container listing (immediate bug fix)
- Full log viewer with filtering and streaming (core feature)

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Cloud-init template changes (Phase 5) only affect newly created nodes — existing nodes keep old config
- The `bootlog` WebSocket pattern in `packages/vm-agent/internal/bootlog/` is the reference implementation for log streaming
- `nodeAgentRequest()` in `apps/api/src/services/node-agent.ts` is the existing proxy pattern to follow
- All configurable values follow Constitution Principle XI — env vars with defaults
