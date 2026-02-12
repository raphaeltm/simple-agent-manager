---

description: "Task list for feature implementation"
---

# Tasks: Multi-Workspace Nodes

**Input**: Design documents from `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/`  
**Prerequisites**: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/plan.md`, `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/spec.md`  
**Optional inputs used**: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/research.md`, `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/data-model.md`, `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/contracts/openapi.yaml`, `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/contracts/websocket-protocol.md`, `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/contracts/node-agent-api.md`, `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/quickstart.md`

**Tests**: This repo requires tests for new/changed behavior (see `/workspaces/hierarchy-planning/AGENTS.md`). Tasks below include test work per user story.

## Format: `- [ ] T### [P?] [US?] Description (absolute file paths)`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[US#]**: Which user story this task belongs to (US1, US2, US3)
- Every task MUST include absolute file paths

## Path Conventions (This Repo)

- Control Plane API (Cloudflare Worker): `/workspaces/hierarchy-planning/apps/api/src/...`
- Control Plane UI (React): `/workspaces/hierarchy-planning/apps/web/src/...`
- Shared types/constants: `/workspaces/hierarchy-planning/packages/shared/src/...`
- Cloud-init generator: `/workspaces/hierarchy-planning/packages/cloud-init/src/...`
- Node Agent (Go, currently `vm-agent`): `/workspaces/hierarchy-planning/packages/vm-agent/...`

---

## Phase 1: Setup (Shared Scaffolding)

**Purpose**: Establish shared types, config defaults, and UI/API scaffolding needed across all stories.

- [X] T001 Update shared domain types for Node/Workspace/AgentSession in `/workspaces/hierarchy-planning/packages/shared/src/types.ts` and exports in `/workspaces/hierarchy-planning/packages/shared/src/index.ts`
- [X] T002 Add env-configurable defaults for node/workspace/session limits in `/workspaces/hierarchy-planning/packages/shared/src/constants.ts`
- [X] T003 [P] Add Nodes + Agent Sessions API client functions in `/workspaces/hierarchy-planning/apps/web/src/lib/api.ts`
- [X] T004 [P] Add Nodes UI route scaffolding in `/workspaces/hierarchy-planning/apps/web/src/App.tsx` and new pages `/workspaces/hierarchy-planning/apps/web/src/pages/Nodes.tsx` and `/workspaces/hierarchy-planning/apps/web/src/pages/Node.tsx`
- [X] T005 Create Nodes API route scaffold in `/workspaces/hierarchy-planning/apps/api/src/routes/nodes.ts` and register route in `/workspaces/hierarchy-planning/apps/api/src/index.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Data model + config gates that must exist before US1/US2/US3 implementation can be completed.

**Checkpoint**: After Phase 2, the repo should typecheck and the database schema should support Nodes, Workspaces-on-Nodes, and Agent Sessions.

- [X] T006 Update database schema for nodes/workspaces/sessions, including Node-scoped normalized workspace-name uniqueness fields/index definitions in `/workspaces/hierarchy-planning/apps/api/src/db/schema.ts`
- [X] T007 Add D1 migration for multi-workspace nodes, including Node-scoped normalized workspace-name unique index in `/workspaces/hierarchy-planning/apps/api/src/db/migrations/0007_multi_workspace_nodes.sql`
- [X] T008 [P] Add ownership helpers for Nodes and Node-scoped Workspaces in `/workspaces/hierarchy-planning/apps/api/src/middleware/node-auth.ts` and update `/workspaces/hierarchy-planning/apps/api/src/middleware/workspace-auth.ts`
- [X] T009 Add env parsing for new limits and heartbeat staleness threshold (`NODE_HEARTBEAT_STALE_SECONDS`) in `/workspaces/hierarchy-planning/apps/api/src/services/limits.ts` and wire optional vars in `/workspaces/hierarchy-planning/apps/api/src/index.ts`
- [X] T010 Add a Node backend DNS helper (vm-{nodeId}) in `/workspaces/hierarchy-planning/apps/api/src/services/dns.ts`
- [X] T011 Ensure terminal token generation no longer depends on `vmIp` in `/workspaces/hierarchy-planning/apps/api/src/routes/terminal.ts`
- [X] T012 [P] Update shared UI components to support Node/Workspace display changes in `/workspaces/hierarchy-planning/apps/web/src/components/WorkspaceCard.tsx`

---

## Phase 3: User Story 1 - Run Multiple Workspaces on One Node (Priority: P1) MVP

**Goal**: Users can create a Node once, create multiple isolated Workspaces inside it, and run them concurrently without disrupting each other (including avoiding port conflicts).

**Independent Test**: Create a Node, create two Workspaces on that Node, confirm both can be opened and operated independently, then stop one Workspace and confirm the other keeps running. (Spec: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/spec.md`)

### Tests for User Story 1

- [X] T013 [P] [US1] Add Nodes API route tests in `/workspaces/hierarchy-planning/apps/api/tests/unit/routes/nodes.test.ts`
- [X] T014 [P] [US1] Update Workspaces API tests for nodeId + create/rename name uniqueness, including concurrent duplicate create/rename protection backed by DB uniqueness rules, in `/workspaces/hierarchy-planning/apps/api/tests/unit/routes/workspaces.test.ts`
- [X] T015 [P] [US1] Add ws-* proxy routing tests (workspace->node resolution + header injection) in `/workspaces/hierarchy-planning/apps/api/tests/unit/ws-proxy.test.ts`
- [X] T016 [P] [US1] Add Nodes UI tests for list/detail/create-workspace flow in `/workspaces/hierarchy-planning/apps/web/tests/unit/pages/nodes.test.tsx` and `/workspaces/hierarchy-planning/apps/web/tests/unit/pages/node.test.tsx`
- [X] T017 [P] [US1] Update Workspace UI tests for new WorkspaceResponse shape in `/workspaces/hierarchy-planning/apps/web/tests/unit/pages/workspace.test.tsx`
- [X] T018 [P] [US1] Add Node Agent routing/auth tests for per-workspace header enforcement in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/workspace_routing_test.go`
- [X] T074 [P] [US1] Add workspace rename API/UI tests in `/workspaces/hierarchy-planning/apps/api/tests/unit/routes/workspaces.test.ts` and `/workspaces/hierarchy-planning/apps/web/tests/unit/pages/workspace.test.tsx`
- [X] T075 [P] [US1] Add Node/Workspace events endpoint tests in `/workspaces/hierarchy-planning/apps/api/tests/unit/routes/nodes.test.ts`, `/workspaces/hierarchy-planning/apps/api/tests/unit/routes/workspaces.test.ts`, and `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/events_test.go`

### Implementation for User Story 1

- [X] T019 [US1] Implement Nodes CRUD (list/create/get) in `/workspaces/hierarchy-planning/apps/api/src/routes/nodes.ts`
- [X] T020 [US1] Implement Node provisioning (Hetzner VM + backend DNS vm-{nodeId} + status updates) in `/workspaces/hierarchy-planning/apps/api/src/services/nodes.ts`
- [X] T021 [US1] Add Node ready callback endpoint (Node Agent -> Control Plane, callback JWT auth) in `/workspaces/hierarchy-planning/apps/api/src/routes/nodes.ts`
- [X] T022 [US1] Update ws-* Worker proxy to route to Node backend, set trusted `X-SAM-Node-Id` + `X-SAM-Workspace-Id`, and strip spoofed client routing headers in `/workspaces/hierarchy-planning/apps/api/src/index.ts`
- [X] T023 [US1] Update workspaces list to support nodeId filtering and Node-scoped fields in `/workspaces/hierarchy-planning/apps/api/src/routes/workspaces.ts`
- [X] T024 [US1] Implement workspace displayName uniqueness within node for create/rename (auto-suffix) in `/workspaces/hierarchy-planning/apps/api/src/services/workspace-names.ts` and use it from `/workspaces/hierarchy-planning/apps/api/src/routes/workspaces.ts`
- [X] T073 [US1] Implement workspace rename endpoint (`PATCH /api/workspaces/:id`) in `/workspaces/hierarchy-planning/apps/api/src/routes/workspaces.ts` and update `/workspaces/hierarchy-planning/apps/web/src/lib/api.ts` plus `/workspaces/hierarchy-planning/apps/web/src/pages/Workspace.tsx`
- [X] T025 [US1] Update workspace create to place workspace on a specific node (and optionally create a new node when nodeId omitted) in `/workspaces/hierarchy-planning/apps/api/src/routes/workspaces.ts`
- [X] T026 [US1] Add Control Plane -> Node Agent client (create/stop/restart/delete workspace) in `/workspaces/hierarchy-planning/apps/api/src/services/node-agent.ts`
- [X] T027 [US1] Add Node Agent management JWT signing in `/workspaces/hierarchy-planning/apps/api/src/services/jwt.ts` and validation in `/workspaces/hierarchy-planning/packages/vm-agent/internal/auth/jwt.go`
- [X] T028 [US1] Update workspace stop/restart/delete to call Node Agent and preserve files/config on stop in `/workspaces/hierarchy-planning/apps/api/src/routes/workspaces.ts`
- [X] T029 [US1] Remove automatic idle shutdown/request-shutdown behavior from Workspace lifecycle and ensure only explicit stop/restart/delete operations change lifecycle state in `/workspaces/hierarchy-planning/apps/api/src/routes/workspaces.ts`, `/workspaces/hierarchy-planning/packages/vm-agent/internal/idle/detector.go`, and `/workspaces/hierarchy-planning/packages/vm-agent/internal/idle/shutdown.go`
- [X] T085 [US1] Remove idle-shutdown countdown/warning UX from Node Agent UI surfaces in `/workspaces/hierarchy-planning/packages/vm-agent/ui/src/App.tsx` and `/workspaces/hierarchy-planning/packages/vm-agent/ui/src/components/StatusBar.tsx`
- [X] T030 [US1] Update cloud-init template to bootstrap a Node Agent (node-scoped) in `/workspaces/hierarchy-planning/packages/cloud-init/src/template.ts` and `/workspaces/hierarchy-planning/packages/cloud-init/src/generate.ts`
- [X] T031 [US1] Update Node provisioning to use node-scoped cloud-init in `/workspaces/hierarchy-planning/apps/api/src/services/nodes.ts`
- [X] T032 [US1] Refactor Node Agent config from WORKSPACE_ID to NODE_ID in `/workspaces/hierarchy-planning/packages/vm-agent/internal/config/config.go` and `/workspaces/hierarchy-planning/packages/vm-agent/main.go`
- [X] T033 [US1] Refactor Node Agent bootstrap so it does not auto-create a workspace on startup in `/workspaces/hierarchy-planning/packages/vm-agent/internal/bootstrap/bootstrap.go`
- [X] T034 [US1] Implement Node Agent workspace management endpoints (create/stop/restart/delete/list) in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/workspaces.go` and register in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/server.go`
- [X] T035 [US1] Implement per-workspace runtime context routing via `X-SAM-Workspace-Id` in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/server.go`
- [X] T036 [US1] Enforce token workspace claim matches routed workspace ID in `/workspaces/hierarchy-planning/packages/vm-agent/internal/auth/jwt.go` and `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/auth_handlers.go`
- [X] T037 [US1] Update terminal WebSocket handlers to use per-workspace container discovery + PTY managers in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/terminal_ws.go` and `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/multi_terminal_ws.go`
- [X] T038 [US1] Add per-workspace port proxy (no host port publishing conflicts) in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/ports_proxy.go`
- [X] T076 [US1] Implement Node Agent Node/Workspace events endpoints in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/events.go` and register them in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/server.go`
- [X] T077 [US1] Add Control Plane passthrough endpoints for Node/Workspace events in `/workspaces/hierarchy-planning/apps/api/src/routes/nodes.ts` and `/workspaces/hierarchy-planning/apps/api/src/routes/workspaces.ts`
- [X] T078 [US1] Surface Node/Workspace event streams in UI in `/workspaces/hierarchy-planning/apps/web/src/pages/Node.tsx` and `/workspaces/hierarchy-planning/apps/web/src/pages/Workspace.tsx`
- [X] T039 [US1] Add Nodes list UI and create-node flow in `/workspaces/hierarchy-planning/apps/web/src/pages/Nodes.tsx`
- [X] T040 [US1] Add Node detail UI (workspaces list + create workspace) in `/workspaces/hierarchy-planning/apps/web/src/pages/Node.tsx`
- [X] T041 [US1] Wire Nodes routes + navigation entry in `/workspaces/hierarchy-planning/apps/web/src/App.tsx` and `/workspaces/hierarchy-planning/apps/web/src/components/UserMenu.tsx`
- [X] T042 [US1] Update create-workspace flow to select a node in `/workspaces/hierarchy-planning/apps/web/src/pages/CreateWorkspace.tsx`
- [X] T043 [US1] Update workspace cards/dashboard to remove VM fields and show node/workspace identity in `/workspaces/hierarchy-planning/apps/web/src/components/WorkspaceCard.tsx` and `/workspaces/hierarchy-planning/apps/web/src/pages/Dashboard.tsx`
- [X] T044 [US1] Update workspace detail UI to reflect new workspace model and ws-url behavior in `/workspaces/hierarchy-planning/apps/web/src/pages/Workspace.tsx`
- [X] T045 [US1] Reconcile implementation with feature docs in `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/contracts/openapi.yaml` and `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/quickstart.md`

**Checkpoint**: US1 complete when Node + 2 concurrent Workspaces work end-to-end and stopping Workspace A does not disrupt Workspace B.

---

## Phase 4: User Story 2 - Create and Manage Agent Sessions in a Workspace (Priority: P2)

**Goal**: Users can create/list/attach/stop multiple Agent Sessions within a Workspace, and can re-attach after refresh while the Workspace remains running.

**Independent Test**: In a single Workspace, start an Agent Session, verify it is listed, refresh the page and attach to it, then start a second session and stop the first. (Spec: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/spec.md`)

### Tests for User Story 2

- [X] T046 [P] [US2] Add Agent Sessions API tests in `/workspaces/hierarchy-planning/apps/api/tests/unit/routes/agent-sessions.test.ts`
- [X] T047 [P] [US2] Update Workspace UI tests for session list + attach in `/workspaces/hierarchy-planning/apps/web/tests/unit/pages/workspace.test.tsx`
- [X] T048 [P] [US2] Add Node Agent unit tests for agent session lifecycle in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/agent_sessions_test.go`
- [X] T086 [P] [US2] Add session attach concurrency/idempotency and attach-stop race tests in `/workspaces/hierarchy-planning/apps/api/tests/unit/routes/agent-sessions.test.ts` and `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/agent_ws_test.go`

### Implementation for User Story 2

- [X] T049 [US2] Add Agent Session types + requests/responses in `/workspaces/hierarchy-planning/packages/shared/src/types.ts` and exports in `/workspaces/hierarchy-planning/packages/shared/src/index.ts`
- [X] T050 [US2] Add Agent Sessions persistence (DB table + queries) in `/workspaces/hierarchy-planning/apps/api/src/db/schema.ts` and `/workspaces/hierarchy-planning/apps/api/src/db/migrations/0007_multi_workspace_nodes.sql`
- [X] T051 [US2] Implement Agent Sessions API endpoints under Workspaces in `/workspaces/hierarchy-planning/apps/api/src/routes/workspaces.ts`
- [X] T052 [US2] Extend Control Plane -> Node Agent client for session operations in `/workspaces/hierarchy-planning/apps/api/src/services/node-agent.ts`
- [X] T053 [US2] Implement Agent Session manager (create/list/stop/status) in `/workspaces/hierarchy-planning/packages/vm-agent/internal/agentsessions/manager.go`
- [X] T054 [US2] Update ACP WebSocket handler to support attach by sessionId, explicit takeover, and deterministic stop/attach race handling (with workspace routing enforcement) in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/agent_ws.go`
- [X] T087 [US2] Implement idempotent session create semantics (`Idempotency-Key`) in `/workspaces/hierarchy-planning/apps/api/src/routes/workspaces.ts` and `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/agent_sessions.go`
- [X] T055 [US2] Add Control Plane API client functions for sessions in `/workspaces/hierarchy-planning/apps/web/src/lib/api.ts`
- [X] T056 [US2] Add Agent Sessions UI (list/create/attach/stop) in `/workspaces/hierarchy-planning/apps/web/src/pages/Workspace.tsx` and new component `/workspaces/hierarchy-planning/apps/web/src/components/AgentSessionList.tsx`
- [X] T057 [US2] Update feature OpenAPI + WebSocket + Node Agent API contracts for session attach semantics in `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/contracts/openapi.yaml`, `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/contracts/websocket-protocol.md`, and `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/contracts/node-agent-api.md`

**Checkpoint**: US2 complete when two sessions can run concurrently and re-attach works after browser refresh.

---

## Phase 5: User Story 3 - Manage Node Lifecycle Safely (Priority: P3)

**Goal**: Users can stop/delete Nodes with clear impact on Workspaces and Agent Sessions, and avoid accidental disruption/data loss.

**Independent Test**: Create a Node with two running Workspaces and at least one running Agent Session, then stop the Node and observe that the UI clearly communicates what happens to Workspaces/sessions. (Spec: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/spec.md`)

### Tests for User Story 3

- [X] T058 [P] [US3] Extend Nodes API tests for stop/delete semantics in `/workspaces/hierarchy-planning/apps/api/tests/unit/routes/nodes.test.ts`
- [X] T059 [P] [US3] Add Node UI tests for stop/delete confirmations in `/workspaces/hierarchy-planning/apps/web/tests/unit/pages/node.test.tsx`
- [X] T060 [P] [US3] Add Node Agent tests ensuring node stop terminates all workspaces/sessions in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/workspaces_test.go`
- [X] T083 [P] [US3] Add Node health heartbeat tests in `/workspaces/hierarchy-planning/apps/api/tests/unit/routes/nodes.test.ts` and `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/health_test.go`
- [X] T088 [P] [US3] Add Node heartbeat stale-threshold and health-state transition tests (healthy->stale->unhealthy) in `/workspaces/hierarchy-planning/apps/api/tests/unit/routes/nodes.test.ts` and `/workspaces/hierarchy-planning/apps/web/tests/unit/pages/node.test.tsx`

### Implementation for User Story 3

- [X] T061 [US3] Implement Node stop (stop all workspaces/sessions + provider power-off or equivalent) in `/workspaces/hierarchy-planning/apps/api/src/routes/nodes.ts`
- [X] T062 [US3] Implement Node delete (VM delete + backend DNS cleanup + DB cleanup) in `/workspaces/hierarchy-planning/apps/api/src/routes/nodes.ts` and `/workspaces/hierarchy-planning/apps/api/src/services/dns.ts`
- [X] T063 [US3] Ensure workspace operations fail with clear errors when parent node is stopped/unhealthy in `/workspaces/hierarchy-planning/apps/api/src/routes/workspaces.ts`
- [X] T064 [US3] Add Node Agent shutdown handling to stop all workspaces/sessions before exit in `/workspaces/hierarchy-planning/packages/vm-agent/main.go`
- [X] T065 [US3] Add UI warnings + confirmations for Node stop/delete in `/workspaces/hierarchy-planning/apps/web/src/pages/Node.tsx`
- [X] T066 [US3] Reconcile Node lifecycle semantics in feature docs in `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/spec.md` and `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/quickstart.md`
- [X] T084 [US3] Implement Node Agent heartbeat/check-in and Control Plane Node health transitions (using `NODE_HEARTBEAT_STALE_SECONDS`) in `/workspaces/hierarchy-planning/packages/vm-agent/internal/server/health.go` and `/workspaces/hierarchy-planning/apps/api/src/routes/nodes.ts`
- [X] T089 [US3] Surface Node health-state badges (`healthy`/`stale`/`unhealthy`) and freshness timestamps in `/workspaces/hierarchy-planning/apps/web/src/pages/Nodes.tsx` and `/workspaces/hierarchy-planning/apps/web/src/pages/Node.tsx`

**Checkpoint**: US3 complete when Node stop reliably stops all child resources and the UI communicates impact before executing.

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Hardening, docs sync, and validation across all stories.

- [X] T067 [P] Update global API contract docs for Nodes/Agent Sessions in `/workspaces/hierarchy-planning/specs/001-mvp/contracts/api.md`
- [X] T068 Update environment variable examples for new limits in `/workspaces/hierarchy-planning/apps/api/.env.example` and `/workspaces/hierarchy-planning/apps/api/wrangler.toml`
- [X] T069 [P] Add/adjust structured logs for node/workspace routing and Node Agent calls in `/workspaces/hierarchy-planning/apps/api/src/index.ts` and `/workspaces/hierarchy-planning/apps/api/src/services/node-agent.ts`
- [X] T070 Run API + Web test suites and fix failures in `/workspaces/hierarchy-planning/apps/api/vitest.config.ts` and `/workspaces/hierarchy-planning/apps/web/vitest.config.ts`
- [X] T071 Run Node Agent Go tests and fix failures in `/workspaces/hierarchy-planning/packages/vm-agent/Makefile`
- [X] T072 Validate quickstart scenarios and adjust docs as needed in `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/quickstart.md`
- [X] T079 Add cross-component integration tests for proxy routing/auth + Node Agent management calls in `/workspaces/hierarchy-planning/apps/api/tests/integration/multi-workspace-nodes.test.ts`
- [X] T080 Add end-to-end Playwright coverage for Node -> Workspace -> Session happy path and failure surfaces in `/workspaces/hierarchy-planning/apps/web/tests/e2e/multi-workspace-nodes.spec.ts`
- [X] T081 Add telemetry instrumentation and metric capture for SC-002/SC-006 in `/workspaces/hierarchy-planning/apps/api/src/services/telemetry.ts` and document in `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/quickstart.md`
- [X] T082 Add explicit backlog note for deferred idle-shutdown redesign in `/workspaces/hierarchy-planning/docs/notes/idle-shutdown-follow-up.md`

---

## Dependencies & Execution Order

### User Story Dependencies

- US1 (P1) is the MVP and unlocks the Node + multi-Workspace substrate.
- US2 (P2) depends on US1 (Workspaces exist and are routable).
- US3 (P3) depends on US1 (Nodes exist and own Workspaces).

### Parallel Opportunities

- Phase 1 tasks marked [P] can run in parallel.
- Phase 2 tasks marked [P] can run in parallel.
- Within each user story, all test tasks marked [P] can be executed in parallel.
- UI work and API work can proceed in parallel after Phase 2 is complete (as long as shared types/contracts are stable).

---

## Parallel Examples

### User Story 1

```bash
Task: "Add Nodes API route tests in /workspaces/hierarchy-planning/apps/api/tests/unit/routes/nodes.test.ts"
Task: "Add Nodes UI tests in /workspaces/hierarchy-planning/apps/web/tests/unit/pages/nodes.test.tsx"
Task: "Add Node Agent routing/auth tests in /workspaces/hierarchy-planning/packages/vm-agent/internal/server/workspace_routing_test.go"
```

### User Story 2

```bash
Task: "Add Agent Sessions API tests in /workspaces/hierarchy-planning/apps/api/tests/unit/routes/agent-sessions.test.ts"
Task: "Add Node Agent unit tests for agent session lifecycle in /workspaces/hierarchy-planning/packages/vm-agent/internal/server/agent_sessions_test.go"
Task: "Update Workspace UI tests for session list + attach in /workspaces/hierarchy-planning/apps/web/tests/unit/pages/workspace.test.tsx"
```

### User Story 3

```bash
Task: "Extend Nodes API tests for stop/delete semantics in /workspaces/hierarchy-planning/apps/api/tests/unit/routes/nodes.test.ts"
Task: "Add Node UI tests for stop/delete confirmations in /workspaces/hierarchy-planning/apps/web/tests/unit/pages/node.test.tsx"
Task: "Add Node Agent tests ensuring node stop terminates all workspaces/sessions in /workspaces/hierarchy-planning/packages/vm-agent/internal/server/workspaces_test.go"
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1 + Phase 2
2. Complete Phase 3 (US1)
3. Validate US1 independent test end-to-end

### Incremental Delivery

1. US1 → deploy/demo
2. US2 → deploy/demo
3. US3 → deploy/demo
