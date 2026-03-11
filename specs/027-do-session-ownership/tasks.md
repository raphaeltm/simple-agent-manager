# Tasks: DO-Owned ACP Session Lifecycle

**Input**: Design documents from `/specs/027-do-session-ownership/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Tests are included for critical paths (infrastructure stability, state machine) per Constitution Principle II.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Shared types, migration schema, and configuration constants

- [ ] T001 [P] Add `AcpSessionStatus`, `AcpSession`, `AcpSessionEvent`, `ForkRequest` types to `packages/shared/src/types.ts`
- [ ] T002 [P] Add configurable env var constants (`ACP_SESSION_HEARTBEAT_INTERVAL_MS`, `ACP_SESSION_DETECTION_WINDOW_MS`, `ACP_SESSION_RECONCILIATION_TIMEOUT_MS`, `ACP_SESSION_FORK_CONTEXT_MESSAGES`, `ACP_SESSION_MAX_FORK_DEPTH`) to `packages/shared/src/constants.ts` (create if needed) with defaults
- [ ] T003 [P] Add ACP session contract types (heartbeat request, status report request, reconciliation response) to `packages/shared/src/vm-agent-contract.ts`
- [ ] T004 Rebuild shared package: `pnpm --filter @simple-agent-manager/shared build`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: DO migration and core session CRUD that all user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T005 Add migration 008 to `apps/api/src/durable-objects/migrations.ts` creating `acp_sessions` and `acp_session_events` tables per data-model.md schema
- [ ] T006 Add `createAcpSession()` method to `apps/api/src/durable-objects/project-data.ts` — insert with status "pending", record creation event in `acp_session_events`
- [ ] T007 Add `getAcpSession()` and `listAcpSessions()` query methods to `apps/api/src/durable-objects/project-data.ts`
- [ ] T008 Add `transitionAcpSession(sessionId, toStatus, { actorType, actorId, reason, metadata })` to `apps/api/src/durable-objects/project-data.ts` — enforce valid transitions per state machine, reject invalid ones with 409, log structured diagnostics
- [ ] T009 Add `mapAcpSessionRow()` private helper to `apps/api/src/durable-objects/project-data.ts` for consistent response mapping
- [ ] T010 [P] Add ACP session service functions (`createAcpSession`, `getAcpSession`, `listAcpSessions`, `transitionAcpSession`) to `apps/api/src/services/project-data.ts` using existing `getStub()` pattern
- [ ] T011 [P] Write unit tests for state machine transitions (all 8 valid + all invalid) in `apps/api/tests/unit/acp-session-state-machine.test.ts`
- [ ] T012 [P] Write migration test verifying tables are created correctly in `apps/api/tests/unit/acp-session-migration.test.ts`
- [ ] T013 Add `.env.example` entries for all 5 ACP session env vars in `apps/api/.env.example`

**Checkpoint**: Foundation ready — ACP sessions can be created, queried, and transitioned in the DO

---

## Phase 3: User Story 1 — Resilient Task Execution (Priority: P1) 🎯 MVP

**Goal**: DO tracks ACP session state machine (pending → assigned → running → completed/failed/interrupted). VM failure detected via heartbeat timeout.

**Independent Test**: Submit a task, verify session record exists in DO with correct state transitions. Simulate VM failure, verify DO marks session as "interrupted".

### Implementation for User Story 1

- [ ] T014 [US1] Add POST `/api/projects/:projectId/acp-sessions` endpoint to `apps/api/src/routes/projects.ts` — create session, validate project exists, validate chatSessionId belongs to project
- [ ] T015 [US1] Add GET `/api/projects/:projectId/acp-sessions` and GET `/api/projects/:projectId/acp-sessions/:sessionId` endpoints to `apps/api/src/routes/projects.ts`
- [ ] T016 [US1] Add POST `/api/projects/:projectId/acp-sessions/:sessionId/assign` endpoint to `apps/api/src/routes/projects.ts` — assign workspace + node, transition to "assigned"
- [ ] T017 [US1] Add POST `/api/projects/:projectId/acp-sessions/:sessionId/status` endpoint to `apps/api/src/routes/projects.ts` — VM agent reports running/completed/failed, validate nodeId matches
- [ ] T018 [US1] Add POST `/api/projects/:projectId/acp-sessions/:sessionId/heartbeat` endpoint to `apps/api/src/routes/projects.ts` — update `last_heartbeat_at`, reset DO alarm
- [ ] T019 [US1] Add `updateHeartbeat(sessionId, nodeId)` method to `apps/api/src/durable-objects/project-data.ts` — validate node match, update timestamp, set alarm for detection window
- [ ] T020 [US1] Add heartbeat timeout check to DO `alarm()` handler in `apps/api/src/durable-objects/project-data.ts` — query stale sessions, transition to "interrupted"
- [ ] T021 [US1] Write integration test: create session → assign → report running → heartbeat → report completed in `apps/api/tests/integration/acp-session-lifecycle.test.ts`
- [ ] T022 [US1] Write integration test: create session → assign → report running → heartbeat timeout → verify interrupted in `apps/api/tests/integration/acp-session-interruption.test.ts`

**Checkpoint**: API endpoints fully functional. Sessions tracked in DO with heartbeat-based interruption detection.

---

## Phase 4: User Story 3 — Workspace-Project Binding (Priority: P1)

**Goal**: Enforce that ACP sessions can only be created for workspaces tied to a project. Bare workspaces (PTY-only) remain creatable.

**Independent Test**: Attempt to create ACP session without a project — verify rejection. Create with project — verify success.

### Implementation for User Story 3

- [ ] T023 [US3] Add workspace-project validation to `POST /api/projects/:projectId/acp-sessions/:sessionId/assign` in `apps/api/src/routes/projects.ts` — verify `workspace.projectId === projectId`, reject with 422 if mismatched
- [ ] T024 [US3] Write test: assign workspace without project → 422 rejection in `apps/api/tests/integration/acp-session-workspace-binding.test.ts`
- [ ] T025 [US3] Write test: assign workspace to wrong project → 422 rejection in same test file

**Checkpoint**: Workspace-project binding enforced. Bare workspaces unaffected.

---

## Phase 5: User Story 4 — VM Agent as Executor (Priority: P2)

**Goal**: VM agent reconciles with control plane on startup, sends heartbeats, reports status changes. Simplified to executor role.

**Independent Test**: Restart VM agent while session is "assigned". Verify it queries control plane and resumes execution.

### Implementation for User Story 4

- [ ] T026 [US4] Add GET `/api/nodes/:nodeId/acp-sessions` reconciliation endpoint to `apps/api/src/routes/nodes.ts` (or projects.ts) — query D1 projection table for sessions assigned to node
- [ ] T027 [US4] Add `listAcpSessionsByNode(nodeId, statuses)` method to `apps/api/src/durable-objects/project-data.ts` for cross-project node queries (or use D1 projection)
- [ ] T028 [US4] Add D1 projection sync: when DO transitions ACP session, upsert `agent_sessions` in D1 via API route or direct D1 write from the route handler
- [ ] T029 [US4] Add reconciliation logic to `packages/vm-agent/internal/agentsessions/manager.go` — on startup, query `GET /api/nodes/:nodeId/acp-sessions?status=assigned,running`, start assigned sessions, report errors for orphaned running sessions
- [ ] T030 [US4] Add heartbeat goroutine to `packages/vm-agent/internal/agentsessions/manager.go` — per active ACP session, POST heartbeat at `ACP_SESSION_HEARTBEAT_INTERVAL_MS`
- [ ] T031 [US4] Add status reporting to `packages/vm-agent/internal/acp/session_host.go` — on ACP SDK session start report "running" with `acpSdkSessionId`, on completion report "completed", on error report "failed"
- [ ] T032 [US4] Add control plane reachability check before starting ACP session in `packages/vm-agent/internal/server/workspaces.go` — fail fast if API unreachable (FR-007)
- [ ] T033 [US4] Write Go unit test for reconciliation logic in `packages/vm-agent/internal/agentsessions/manager_test.go`
- [ ] T034 [US4] Write Go unit test for heartbeat goroutine start/stop in `packages/vm-agent/internal/agentsessions/heartbeat_test.go`

**Checkpoint**: VM agent acts as executor. Reconciles on startup, sends heartbeats, reports status.

---

## Phase 6: User Story 2 — Session Forking for Continuity (Priority: P2)

**Goal**: Users can fork completed/interrupted sessions. New session created with context summary. Fork lineage tracked.

**Independent Test**: Complete a task, destroy workspace, send follow-up. Verify new session with context from original.

### Implementation for User Story 2

- [ ] T035 [US2] Add `forkAcpSession(sessionId, contextSummary)` method to `apps/api/src/durable-objects/project-data.ts` — create child session with `parentSessionId`, increment `fork_depth`, enforce max depth
- [ ] T036 [US2] Add `getAcpSessionLineage(sessionId)` method to `apps/api/src/durable-objects/project-data.ts` — walk parent chain and collect children
- [ ] T037 [US2] Add POST `/api/projects/:projectId/acp-sessions/:sessionId/fork` endpoint to `apps/api/src/routes/projects.ts` — validate terminal state, call DO fork method
- [ ] T038 [US2] Add GET `/api/projects/:projectId/acp-sessions/:sessionId/lineage` endpoint to `apps/api/src/routes/projects.ts`
- [ ] T039 [US2] Write integration test: fork completed session → verify child with correct parentSessionId and forkDepth in `apps/api/tests/integration/acp-session-fork.test.ts`
- [ ] T040 [US2] Write test: fork beyond max depth → 422 rejection in same test file
- [ ] T041 [US2] Write test: fork non-terminal session → 409 rejection in same test file

**Checkpoint**: Session forking works. Lineage queryable. Depth limits enforced.

---

## Phase 7: User Story 5 — Session Tree for Sub-Agent Orchestration (Priority: P3)

**Goal**: Data model supports parent-child session trees via `parentSessionId`. UI shows tree structure.

**Independent Test**: Create session with `parentSessionId`, verify DO tracks relationship and lineage query returns tree.

### Implementation for User Story 5

- [ ] T042 [US5] Verify `parentSessionId` is already functional from fork implementation (T035-T038). Add test creating session with explicit `parentSessionId` (not via fork) in `apps/api/tests/integration/acp-session-tree.test.ts`
- [ ] T043 [US5] Add tree query: `getAcpSessionTree(rootSessionId)` to `apps/api/src/durable-objects/project-data.ts` — recursive CTE to get full tree from any node

**Checkpoint**: Session tree data model proven. Ready for future MCP sub-agent integration.

---

## Phase 8: UI Updates

**Purpose**: Show session states, fork lineage, and interruption in the chat interface

- [ ] T044 [P] Create `SessionStatusBadge` component in `apps/web/src/components/SessionStatusBadge.tsx` — render colored badges for pending/assigned/running/completed/failed/interrupted states
- [ ] T045 [P] Create `ForkLineageIndicator` component in `apps/web/src/components/ForkLineageIndicator.tsx` — show "Continued from previous session" divider and lineage breadcrumb
- [ ] T046 Update `ProjectChat.tsx` in `apps/web/src/pages/ProjectChat.tsx` to fetch and display ACP session status alongside chat sessions
- [ ] T047 Add "Continue" action button for interrupted/completed sessions in `apps/web/src/pages/ProjectChat.tsx` — triggers fork flow
- [ ] T048 [P] Write behavioral test for `SessionStatusBadge` rendering all states in `apps/web/tests/unit/SessionStatusBadge.test.tsx`
- [ ] T049 [P] Write behavioral test for `ForkLineageIndicator` in `apps/web/tests/unit/ForkLineageIndicator.test.tsx`

**Checkpoint**: UI shows session states and fork lineage. Users can trigger continuation.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, integration verification, cleanup

- [ ] T050 [P] Update `apps/api/.env.example` with all ACP session env vars and comments
- [ ] T051 [P] Add structured logging at every state transition in DO methods (sessionId, chatSessionId, workspaceId, nodeId, projectId, fromStatus, toStatus)
- [ ] T052 Write capability test: full lifecycle from task submission → DO session creation → assignment → running → heartbeat → completion in `apps/api/tests/integration/acp-session-capability.test.ts`
- [ ] T053 Verify PTY sessions are unaffected — write test confirming PTY operations work without project binding in `apps/api/tests/integration/pty-session-unchanged.test.ts`
- [ ] T054 Move task file from `tasks/active/` to `tasks/archive/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational — core API endpoints
- **US3 (Phase 4)**: Depends on Phase 3 (uses assign endpoint)
- **US4 (Phase 5)**: Depends on Phase 3 (uses all endpoints). Go changes independent of TS.
- **US2 (Phase 6)**: Depends on Phase 2 only (fork is a DO method + endpoint)
- **US5 (Phase 7)**: Depends on Phase 6 (extends fork/lineage)
- **UI (Phase 8)**: Depends on Phase 3 (needs API endpoints to call)
- **Polish (Phase 9)**: Depends on all previous phases

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational — no other story dependencies
- **US3 (P1)**: Can start after US1 assign endpoint exists
- **US4 (P2)**: Can start after US1 endpoints exist (Go work parallelizable)
- **US2 (P2)**: Can start after Foundational — fork is independent of US1 endpoints
- **US5 (P3)**: Depends on US2 fork lineage implementation

### Within Each User Story

- Models/schema before service methods
- Service methods before API endpoints
- API endpoints before tests that exercise them
- Core implementation before integration

### Parallel Opportunities

- T001, T002, T003 (all setup types) — different files
- T010, T011, T012 (service + tests) — different files, after DO methods
- T044, T045 (UI components) — different files
- T048, T049 (UI tests) — different files
- US4 Go changes (T029-T034) can run in parallel with US2 TS changes (T035-T041)

---

## Parallel Example: Phase 2

```bash
# After T005-T009 (DO methods), launch in parallel:
Task T010: "Add service functions to apps/api/src/services/project-data.ts"
Task T011: "Write state machine unit tests"
Task T012: "Write migration test"
```

## Parallel Example: Phase 8

```bash
# Launch UI components in parallel:
Task T044: "Create SessionStatusBadge component"
Task T045: "Create ForkLineageIndicator component"

# After both complete, launch tests in parallel:
Task T048: "Test SessionStatusBadge"
Task T049: "Test ForkLineageIndicator"
```

---

## Implementation Strategy

### MVP First (User Story 1 + 3 Only)

1. Complete Phase 1: Setup (types + constants)
2. Complete Phase 2: Foundational (migration + DO CRUD + state machine)
3. Complete Phase 3: User Story 1 (API endpoints + heartbeat + interruption)
4. Complete Phase 4: User Story 3 (workspace-project binding)
5. **STOP and VALIDATE**: Test full lifecycle end-to-end
6. Deploy to staging and verify

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 + US3 → Core session lifecycle (MVP!)
3. Add US4 → VM agent reconciliation + heartbeat
4. Add US2 → Session forking for continuity
5. Add US5 → Session tree data model
6. Add UI → Visual session states and fork lineage
7. Each story adds value without breaking previous stories

---

## Summary

- **Total tasks**: 54
- **Phase 1 (Setup)**: 4 tasks
- **Phase 2 (Foundational)**: 9 tasks
- **Phase 3 (US1 - Resilient Task Execution)**: 9 tasks
- **Phase 4 (US3 - Workspace-Project Binding)**: 3 tasks
- **Phase 5 (US4 - VM Agent as Executor)**: 9 tasks
- **Phase 6 (US2 - Session Forking)**: 7 tasks
- **Phase 7 (US5 - Session Tree)**: 2 tasks
- **Phase 8 (UI)**: 6 tasks
- **Phase 9 (Polish)**: 5 tasks
- **Parallel opportunities**: 15+ tasks can run in parallel at various points
- **Suggested MVP scope**: Phases 1-4 (US1 + US3) = 25 tasks
