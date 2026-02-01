# Tasks: MVP Hardening

**Input**: Design documents from `/specs/004-mvp-hardening/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/api.yaml

**Tests**: Included for critical paths (bootstrap, ownership, timeout) per Constitution Principle II requiring 90% coverage for critical paths.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **apps/api/**: Cloudflare Workers API (Hono)
- **apps/web/**: React control plane UI
- **packages/terminal/**: NEW shared terminal package
- **packages/vm-agent/**: Go VM agent
- **packages/cloud-init/**: Cloud-init template generator
- **packages/shared/**: Shared types and utilities

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create terminal package structure and initialize dependencies

- [x] T001 Create packages/terminal/ directory structure per plan.md
- [x] T002 [P] Initialize packages/terminal/package.json with name "@repo/terminal"
- [x] T003 [P] Create packages/terminal/tsconfig.json extending root config
- [x] T004 Add @repo/terminal to pnpm workspace in root package.json
- [x] T005 Install terminal dependencies: @xterm/xterm, @xterm/addon-fit, @xterm/addon-attach in packages/terminal/

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T006 Add errorReason TEXT column to workspaces table in apps/api/src/db/schema.ts
- [x] T007 Add shutdownDeadline TEXT column to workspaces table in apps/api/src/db/schema.ts
- [x] T008 Create D1 migration file for new columns in apps/api/drizzle/
- [x] T009 Create requireWorkspaceOwnership helper in apps/api/src/middleware/workspace-auth.ts
- [x] T010 [P] Add BootstrapTokenData interface in packages/shared/src/types.ts
- [x] T011 [P] Add BootstrapResponse interface in packages/shared/src/types.ts
- [x] T012 [P] Update WorkspaceResponse interface with errorReason and shutdownDeadline in packages/shared/src/types.ts
- [x] T013 [P] Update HeartbeatResponse interface with shutdownDeadline in packages/shared/src/types.ts
- [x] T014 Add cron trigger configuration to apps/api/wrangler.toml

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Secure Credential Handling (Priority: P1) MVP

**Goal**: Replace plaintext secrets in cloud-init with one-time bootstrap tokens stored in KV

**Independent Test**: After creating a workspace, examining VM cloud-init user data in Hetzner console reveals no sensitive tokens

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T015 [P] [US1] Unit test for bootstrap token generation in apps/api/tests/unit/services/bootstrap.test.ts
- [x] T016 [P] [US1] Unit test for bootstrap token redemption in apps/api/tests/unit/routes/bootstrap.test.ts
- [x] T017 [P] [US1] Test bootstrap token expiry (KV TTL) in apps/api/tests/unit/services/bootstrap.test.ts
- [x] T018 [P] [US1] Test bootstrap token single-use enforcement in apps/api/tests/unit/routes/bootstrap.test.ts

### Implementation for User Story 1

- [x] T019 [US1] Create generateBootstrapToken function in apps/api/src/services/bootstrap.ts
- [x] T020 [US1] Implement storeBootstrapToken with KV TTL in apps/api/src/services/bootstrap.ts
- [x] T021 [US1] Create POST /api/bootstrap/:token endpoint in apps/api/src/routes/bootstrap.ts
- [x] T022 [US1] Implement redeemBootstrapToken (get + delete) in apps/api/src/services/bootstrap.ts
- [x] T023 [US1] Register bootstrap routes in apps/api/src/index.ts
- [x] T024 [US1] Modify workspace creation to generate bootstrap token in apps/api/src/services/workspace.ts
- [x] T025 [US1] Update cloud-init template to use bootstrap URL instead of embedded secrets in packages/cloud-init/src/template.ts
- [x] T026 [US1] Add bootstrap token redemption on VM startup in packages/vm-agent/main.go
- [x] T027 [US1] Add bootstrap configuration (controlPlaneUrl) to VM Agent config in packages/vm-agent/internal/config/config.go
- [x] T028 [US1] Handle bootstrap failure with exponential backoff in packages/vm-agent/main.go

**Checkpoint**: Bootstrap token flow complete. VM can start without plaintext secrets in cloud-init.

---

## Phase 4: User Story 2 - Workspace Access Control (Priority: P2)

**Goal**: All workspace operations validate user ownership to prevent IDOR attacks

**Independent Test**: Attempting to access another user's workspace ID returns 404 (not 403)

### Tests for User Story 2

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T029 [P] [US2] Test ownership validation returns 404 for non-owned workspace in apps/api/tests/unit/middleware/workspace-auth.test.ts
- [x] T030 [P] [US2] Test GET /workspaces/:id rejects non-owner in apps/api/tests/unit/routes/workspaces.test.ts
- [x] T031 [P] [US2] Test DELETE /workspaces/:id rejects non-owner in apps/api/tests/unit/routes/workspaces.test.ts
- [x] T032 [P] [US2] Test workspace list filters by user in apps/api/tests/unit/routes/workspaces.test.ts

### Implementation for User Story 2

- [x] T033 [US2] Apply requireWorkspaceOwnership to GET /api/workspaces/:id in apps/api/src/routes/workspaces.ts
- [x] T034 [US2] Apply requireWorkspaceOwnership to DELETE /api/workspaces/:id in apps/api/src/routes/workspaces.ts
- [x] T035 [US2] Update GET /api/workspaces to filter by authenticated user in apps/api/src/routes/workspaces.ts
- [x] T036 [US2] Apply ownership validation to terminal WebSocket route in apps/api/src/routes/terminal.ts
- [x] T037 [US2] Return 404 (not 403) for non-owned workspaces to prevent information disclosure in apps/api/src/middleware/workspace-auth.ts

**Checkpoint**: Workspace access control complete. Users cannot access each other's workspaces.

---

## Phase 5: User Story 3 - Reliable Workspace Provisioning (Priority: P3)

**Goal**: Workspaces stuck in "Creating" status automatically transition to "Error" after timeout

**Independent Test**: A workspace that doesn't receive "ready" callback within 10 minutes shows "Error" status (checked every 5 minutes)

### Tests for User Story 3

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T038 [P] [US3] Test timeout detection identifies stuck workspaces in apps/api/tests/unit/services/timeout.test.ts
- [x] T039 [P] [US3] Test error status includes errorReason in apps/api/tests/unit/services/timeout.test.ts
- [x] T040 [P] [US3] Test cron handler processes timeouts in apps/api/tests/integration/timeout.test.ts

### Implementation for User Story 3

- [x] T041 [US3] Create checkProvisioningTimeouts service function in apps/api/src/services/timeout.ts
- [x] T042 [US3] Query workspaces with status='creating' and createdAt older than 10 minutes in apps/api/src/services/timeout.ts
- [x] T043 [US3] Update matched workspaces to status='error' with errorReason in apps/api/src/services/timeout.ts
- [x] T044 [US3] Add scheduled handler export in apps/api/src/index.ts
- [x] T045 [US3] Call checkProvisioningTimeouts from cron handler in apps/api/src/index.ts
- [x] T046 [US3] Add errorReason to workspace API responses in apps/api/src/routes/workspaces.ts
- [x] T047 [US3] Display error message in web UI workspace list in apps/web/src/pages/Dashboard.tsx

**Checkpoint**: Provisioning timeout handling complete. Stuck workspaces automatically marked as failed.

---

## Phase 6: User Story 6 - Consolidated Terminal Experience (Priority: P6)

**Goal**: Single shared terminal component used by both web UI and VM agent UI

**Independent Test**: Both apps/web and packages/vm-agent/ui import terminal from same @repo/terminal package

**Note**: This story is P6 but implemented before P4/P5 because those stories depend on it.

### Implementation for User Story 6

- [x] T048 [P] [US6] Create ConnectionState type in packages/terminal/src/types.ts
- [x] T049 [P] [US6] Create TerminalProps interface in packages/terminal/src/types.ts
- [x] T050 [P] [US6] Create StatusBarProps interface in packages/terminal/src/types.ts
- [x] T051 [US6] Implement useWebSocket hook with basic connection in packages/terminal/src/useWebSocket.ts
- [x] T052 [US6] Implement useIdleDeadline hook for deadline tracking in packages/terminal/src/useIdleDeadline.ts
- [x] T053 [US6] Create StatusBar component displaying connection state in packages/terminal/src/StatusBar.tsx
- [x] T054 [US6] Create ConnectionOverlay component for reconnecting/failed states in packages/terminal/src/ConnectionOverlay.tsx
- [x] T055 [US6] Create Terminal component with xterm.js integration in packages/terminal/src/Terminal.tsx
- [x] T056 [US6] Export all components and hooks from packages/terminal/src/index.ts
- [x] T057 [US6] Add @repo/terminal dependency to apps/web/package.json
- [x] T058 [US6] Replace existing terminal in apps/web/src/pages/Workspace.tsx with shared component
- [x] T059 [US6] Add @repo/terminal dependency to packages/vm-agent/ui/package.json
- [x] T060 [US6] Replace existing terminal in packages/vm-agent/ui/src/App.tsx with shared component

**Checkpoint**: Terminal consolidation complete. Both UIs use identical terminal component.

---

## Phase 7: User Story 4 - Stable Terminal Connections (Priority: P4)

**Goal**: Terminal automatically reconnects when WebSocket connection drops unexpectedly

**Independent Test**: Disabling network briefly and re-enabling results in automatic terminal reconnection

### Tests for User Story 4

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T061 [P] [US4] Test WebSocket reconnection attempts on close in packages/terminal/tests/useWebSocket.test.ts
- [x] T062 [P] [US4] Test exponential backoff timing in packages/terminal/tests/useWebSocket.test.ts
- [x] T063 [P] [US4] Test max retries stops reconnection in packages/terminal/tests/useWebSocket.test.ts

### Implementation for User Story 4

- [x] T064 [US4] Add reconnection logic with exponential backoff to useWebSocket in packages/terminal/src/useWebSocket.ts
- [x] T065 [US4] Track retry count and implement max retries (5) in packages/terminal/src/useWebSocket.ts
- [x] T066 [US4] Add manual retry function exposed from useWebSocket in packages/terminal/src/useWebSocket.ts
- [x] T067 [US4] Update ConnectionOverlay to show "Reconnecting..." with attempt count in packages/terminal/src/ConnectionOverlay.tsx
- [x] T068 [US4] Update ConnectionOverlay to show "Click to retry" after max failures in packages/terminal/src/ConnectionOverlay.tsx
- [x] T069 [US4] Detect workspace stopped during reconnection and show appropriate message in packages/terminal/src/ConnectionOverlay.tsx

**Checkpoint**: Terminal reconnection complete. Network interruptions handled gracefully.

---

## Phase 8: User Story 5 - Predictable Idle Shutdown (Priority: P5)

**Goal**: Users see specific shutdown deadline time that extends on activity

**Independent Test**: Terminal status bar shows "Auto-shutdown at [specific time]" that updates on activity

### Tests for User Story 5

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T070 [P] [US5] Test deadline extends on activity in packages/vm-agent/internal/idle/detector_test.go
- [x] T071 [P] [US5] Test heartbeat response includes deadline in apps/api/tests/unit/routes/heartbeat.test.ts
- [x] T072 [P] [US5] Test deadline display formatting in packages/terminal/tests/useIdleDeadline.test.ts

### Implementation for User Story 5

- [x] T073 [US5] Change idle detector from duration-based to deadline-based in packages/vm-agent/internal/idle/detector.go
- [x] T074 [US5] Add GetDeadline() method to idle detector in packages/vm-agent/internal/idle/detector.go
- [x] T075 [US5] Update RecordActivity() to extend deadline by timeout period in packages/vm-agent/internal/idle/detector.go
- [x] T076 [US5] Add shutdownDeadline to heartbeat response in apps/api/src/routes/workspaces.ts
- [x] T077 [US5] Update VM Agent heartbeat handler to include deadline in packages/vm-agent/internal/server/routes.go
- [x] T078 [US5] Update StatusBar to display shutdown deadline time in packages/terminal/src/StatusBar.tsx
- [x] T079 [US5] Add 5-minute warning display to StatusBar in packages/terminal/src/StatusBar.tsx
- [x] T080 [US5] Format deadline in user's local timezone in packages/terminal/src/useIdleDeadline.ts
- [x] T081 [US5] Add shutdownDeadline to workspace list response in apps/api/src/routes/workspaces.ts
- [x] T082 [US5] Display shutdown deadline in dashboard workspace cards in apps/web/src/pages/Dashboard.tsx

**Checkpoint**: Idle deadline tracking complete. Users always know when workspace will shut down.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T083 [P] Update CLAUDE.md with 004-mvp-hardening technology changes
- [x] T084 [P] Update README.md with new bootstrap flow documentation
- [x] T085 [P] Add API documentation for new bootstrap endpoint in docs/
- [x] T086 Code cleanup and remove unused imports across modified files
- [x] T087 Run quickstart.md validation to verify dev workflow
- [x] T088 Run security-auditor agent to review all security-sensitive changes
- [x] T089 Run test-engineer agent to verify coverage meets 90% for critical paths

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational - Independent of other user stories
- **US2 (Phase 4)**: Depends on Foundational - Independent of other user stories
- **US3 (Phase 5)**: Depends on Foundational - Independent of other user stories
- **US6 (Phase 6)**: Depends on Setup (terminal package structure)
- **US4 (Phase 7)**: Depends on US6 (uses shared terminal package)
- **US5 (Phase 8)**: Depends on US6 (uses shared terminal package)
- **Polish (Phase 9)**: Depends on all user stories being complete

### User Story Dependencies

```
Phase 1 (Setup)
    │
    ▼
Phase 2 (Foundational) ─────────────────────────────────────┐
    │                                                        │
    ├───────────────┬───────────────┬───────────────────────┼───▶ Phase 6 (US6)
    │               │               │                       │          │
    ▼               ▼               ▼                       │          ├────────┬────────┐
Phase 3 (US1)  Phase 4 (US2)  Phase 5 (US3)                │          ▼        ▼        │
    │               │               │                       │     Phase 7  Phase 8      │
    │               │               │                       │     (US4)    (US5)        │
    └───────────────┴───────────────┴───────────────────────┴──────────┴────────────────┘
                                                                              │
                                                                              ▼
                                                                      Phase 9 (Polish)
```

### Within Each User Story

- Tests (if included) MUST be written and FAIL before implementation
- Services before routes/endpoints
- Backend before frontend
- Core implementation before integration

### Parallel Opportunities

**Phase 1 (Setup)**:
- T002, T003 can run in parallel

**Phase 2 (Foundational)**:
- T010, T011, T012, T013 (type definitions) can run in parallel

**Phase 3 (US1)**:
- T015, T016, T017, T018 (tests) can run in parallel

**Phase 4 (US2)**:
- T029, T030, T031, T032 (tests) can run in parallel

**Phase 5 (US3)**:
- T038, T039, T040 (tests) can run in parallel

**Phase 6 (US6)**:
- T048, T049, T050 (type definitions) can run in parallel

**Phase 7 (US4)**:
- T061, T062, T063 (tests) can run in parallel

**Phase 8 (US5)**:
- T070, T071, T072 (tests) can run in parallel

**Phase 9 (Polish)**:
- T083, T084, T085 can run in parallel

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Unit test for bootstrap token generation in apps/api/tests/unit/services/bootstrap.test.ts"
Task: "Unit test for bootstrap token redemption in apps/api/tests/unit/routes/bootstrap.test.ts"
Task: "Test bootstrap token expiry (KV TTL) in apps/api/tests/unit/services/bootstrap.test.ts"
Task: "Test bootstrap token single-use enforcement in apps/api/tests/unit/routes/bootstrap.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 (Secure Credentials)
4. **STOP and VALIDATE**: Test that cloud-init no longer contains plaintext secrets
5. Deploy/demo if ready - this alone is a significant security improvement

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 (Secure Credentials) → Test → Deploy (MVP!)
3. Add US2 (Access Control) → Test → Deploy
4. Add US3 (Provisioning Timeout) → Test → Deploy
5. Add US6 (Terminal Package) → Test
6. Add US4 (Reconnection) → Test → Deploy
7. Add US5 (Idle Deadline) → Test → Deploy
8. Polish → Final release

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: US1 (Secure Credentials)
   - Developer B: US2 (Access Control)
   - Developer C: US3 (Provisioning Timeout)
3. After US1/US2/US3 complete:
   - Developer A: US6 (Terminal Package)
4. After US6 complete:
   - Developer B: US4 (Reconnection)
   - Developer C: US5 (Idle Deadline)
5. All team: Polish phase

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Critical paths (bootstrap, ownership, timeout) require 90% test coverage per Constitution
