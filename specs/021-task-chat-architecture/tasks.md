# Tasks: Task-Driven Chat Architecture & Autonomous Workspace Execution

**Input**: Design documents from `/specs/021-task-chat-architecture/`
**Prerequisites**: plan.md, spec.md, data-model.md, contracts/api-contracts.md, research.md, quickstart.md

**Tests**: TDD approach requested. Every implementation task has interleaved test coverage. Critical paths target >90% coverage. Integration and E2E tests are separate explicit tasks.

**Organization**: Tasks grouped by user story priority. Phase 1-2 are shared infrastructure/foundational. Phase 3+ are user stories in priority order (P1 first).

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks in same phase)
- **[Story]**: Which user story this task belongs to (US1-US7)
- All file paths are relative to repository root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Shared types, database migrations, dependency additions, and interface extensions that all subsequent phases depend on.

- [x] T001 Add shared types PersistMessageBatchRequest, PersistMessageBatchResponse, PersistMessageItem, NodeLifecycleStatus, and NodeLifecycleState to `packages/shared/src/types/`
- [x] T002 [P] Create D1 migration `XXXX_add_project_default_vm_size.sql` adding nullable `default_vm_size TEXT` column to projects table in `apps/api/migrations/` (already existed as 0015)
- [x] T003 [P] Create D1 migration `0017_node_warm_since.sql` adding nullable `warm_since TEXT` column to nodes table in `apps/api/src/db/migrations/`
- [x] T004 Update Drizzle schema: add `warmSince: text('warm_since')` to nodes table in `apps/api/src/db/schema.ts` (defaultVmSize already existed)
- [x] T005 [P] Add `cenkalti/backoff/v5` dependency to `packages/vm-agent/go.mod` and run `go mod tidy`
- [x] T006 [P] Extend CloudInitVariables interface with optional `projectId` and `chatSessionId` fields in `packages/cloud-init/src/generate.ts`
- [x] T007 [P] Add `session.created` and `session.stopped` WebSocket broadcast event types to shared types in `packages/shared/src/types.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure changes to ProjectData DO, cloud-init generation, and the batch message API endpoint. MUST complete before any user story work.

**CRITICAL**: No user story work can begin until this phase is complete.

### ProjectData DO Changes

- [x] T008 Update ProjectData DO `createSession()` to accept optional `taskId` parameter, add `task_id` column migration to DO SQLite, create index on `task_id`, and broadcast `session.created` event in `apps/api/src/durable-objects/project-data.ts`
- [x] T009 Unit tests for createSession with taskId in `apps/api/tests/workers/project-data-do.test.ts` — **Scenarios**: (1) create session with taskId stores and returns it, (2) create session without taskId stores null, (3) listSessions with taskId filter returns only matching sessions, (4) session.created WebSocket broadcast includes taskId, (5) session.stopped broadcast on stopSession, (6) task_id index created in migration

### Batch Message Persistence in DO

- [x] T010 Implement `persistMessageBatch()` method on ProjectData DO for bulk insert with messageId deduplication (UNIQUE constraint skip), per-message WebSocket broadcast, message_count increment, and topic auto-capture in `apps/api/src/durable-objects/project-data.ts`
- [x] T011 Unit tests for persistMessageBatch in `apps/api/tests/workers/project-data-do.test.ts` — **Scenarios**: (1) batch of 5 messages all persisted and broadcast, (2) duplicate messageId silently skipped and counted, (3) mixed new + duplicate returns correct persisted/duplicates counts, (4) session message_count incremented by persisted count only, (5) topic auto-captured from first user-role message if not set, (6) session updated_at bumped, (7) invalid session_id returns error

### Cloud-Init Generation

- [x] T012 Update cloud-init template generation to substitute `projectId` and `chatSessionId` as `PROJECT_ID` and `CHAT_SESSION_ID` environment variables in systemd service in `packages/cloud-init/src/generate.ts`
- [x] T013 Unit tests for cloud-init with new variables in `packages/cloud-init/tests/generate.test.ts` — **Scenarios**: (1) projectId and chatSessionId substituted into template, (2) nullable values produce empty env vars (not "undefined"), (3) generated config passes size validation with new vars, (4) existing variables still substituted correctly (no regression)

### Batch Message API Endpoint

- [x] T014 Implement `POST /api/workspaces/:workspaceId/messages` route with callback JWT auth, request validation (1-100 messages, role enum, non-empty content, UUID messageId, ISO timestamp, 256KB payload limit), workspace-to-project resolution, and DO delegation in `apps/api/src/routes/workspaces.ts`
- [x] T015 Unit tests for batch message endpoint in `apps/api/tests/unit/routes/workspace-messages.test.ts` — **Scenarios**: (1) valid batch of 2 messages returns 200 with persisted count, (2) empty messages array returns 400, (3) >100 messages returns 400, (4) invalid role returns 400, (5) empty content returns 400, (6) missing auth returns 401, (7) JWT workspace claim mismatch returns 403, (8) non-existent session returns 404, (9) payload >256KB returns 413, (10) duplicate messageId returns 200 with duplicates count, (11) workspace without project returns appropriate error

### Workspace Creation Session Hook

- [x] T016 Update workspace creation flow: when `projectId` is set, create chat session in ProjectData DO and store `chatSessionId` on workspace record; include `chatSessionId` in runtime endpoint response in `apps/api/src/routes/workspaces.ts`
- [x] T017 Unit tests for workspace creation chat session in `apps/api/tests/unit/routes/workspace-session-hook.test.ts` — **Scenarios**: (1) workspace with projectId creates session and stores chatSessionId, (2) workspace without projectId skips session creation, (3) session creation failure does not block workspace creation (best-effort), (4) runtime endpoint returns chatSessionId

**Checkpoint**: Foundation ready — all shared types, migrations, DO methods, cloud-init, and API endpoint are in place. User story implementation can begin.

---

## Phase 3: User Story 1 — Agent-Side Chat Persistence (Priority: P1)

**Goal**: The VM agent persists all chat messages to the ProjectData DO via the control plane API. Browser is read-only. Messages survive browser disconnection, workspace destruction, and transient network failures.

**Independent Test**: Start a workspace with a project, send messages to the agent, close the browser entirely, reopen the project page, verify all messages (user, assistant, tool metadata) are present in session history.

**Covers**: FR-001 through FR-007, FR-039 through FR-041

### Go Message Reporter Package (TDD)

- [x] T018 [P] [US1] Create `config.go` with Config struct parsing all MSG_* env vars with defaults (BatchMaxWait=2s, BatchMaxSize=50, BatchMaxBytes=64KB, OutboxMaxSize=10000, RetryInitial=1s, RetryMax=30s, RetryMaxElapsed=5min) in `packages/vm-agent/internal/messagereport/config.go`
- [x] T019 [P] [US1] Create `schema.go` with SQLite outbox DDL (message_outbox table with id, message_id UNIQUE, project_id, session_id, role, content, tool_metadata, created_at, attempts, last_attempt_at) and idempotent migration in `packages/vm-agent/internal/messagereport/schema.go`
- [x] T020 [US1] Implement `reporter.go` — New() initializes SQLite outbox + starts flush goroutine, Enqueue() inserts to outbox (non-blocking, returns error if full), flushLoop() reads oldest N from outbox and POSTs batch to API, SetToken() updates auth, Shutdown() final flush + wait. Follow errorreport.Reporter pattern: nil-safe, stopC/doneC channels, graceful shutdown in `packages/vm-agent/internal/messagereport/reporter.go`
- [x] T021 [US1] Unit tests for message reporter (TDD — write first, implement to pass) in `packages/vm-agent/internal/messagereport/reporter_test.go` — **Scenarios**: (1) New() with valid config succeeds and creates outbox table, (2) New() with nil DB returns error, (3) Enqueue() inserts message into SQLite outbox, (4) flush reads oldest N messages ordered by created_at, (5) successful POST (200) deletes sent messages from outbox, (6) failed POST (500) retries with exponential backoff, (7) permanent error (400/401/403) discards messages and logs warning, (8) 429 retries (transient), (9) outbox at max size returns error on Enqueue, (10) Shutdown() flushes remaining messages before returning, (11) nil Reporter methods are no-ops (nil-safe), (12) SetToken() updates Authorization header on subsequent POSTs, (13) batch respects BatchMaxSize limit, (14) batch respects BatchMaxBytes limit, (15) concurrent Enqueue from multiple goroutines is safe, (16) network timeout triggers retry, (17) outbox overflow drops oldest messages with warning log

### ACP Session Integration

- [x] T022 [US1] Implement `extractMessages()` helper to convert ACP `SessionNotification` to `messagereport.Message` structs — extract role, content, tool metadata from notification params in `packages/vm-agent/internal/acp/message_extract.go`
- [x] T023 [US1] Unit tests for extractMessages in `packages/vm-agent/internal/acp/message_extract_test.go` — **Scenarios**: (1) user message extracted with correct role and content, (2) assistant message extracted with content, (3) tool call maps to Message with ToolMetadata (tool name, target, status), (4) empty/nil notification returns empty slice, (5) multiple messages in single notification all extracted, (6) message timestamps set to current time, (7) messageId generated as UUID for each
- [x] T024 [US1] Hook messageReporter into SessionHost: add messageReporter field to SessionHost struct, update NewSessionHost to accept reporter, call reporter.Enqueue in SessionUpdate callback in `packages/vm-agent/internal/acp/session_host.go`
- [x] T025 [US1] Unit tests for SessionUpdate persistence hook in `packages/vm-agent/internal/acp/session_host_test.go` — **Scenarios**: (1) messageReporter nil — SessionUpdate still broadcasts to viewers (no-op for persistence), (2) messageReporter configured — messages enqueued for each extracted message, (3) Enqueue error (outbox full) logged as warning but SessionUpdate returns nil (non-blocking), (4) SessionHost.Stop() calls reporter.Shutdown()

### VM Agent Startup Integration

- [x] T026 [US1] Initialize messageReporter in VM agent main startup: read PROJECT_ID and CHAT_SESSION_ID env vars, if PROJECT_ID is set create reporter with existing SQLite DB, pass to SessionHost config in `packages/vm-agent/cmd/` (main entry point)

### End-to-End Validation

- [x] T027 [US1] Integration test: full message persistence flow — enqueue message in Go reporter mock → HTTP POST to Miniflare API → ProjectData DO persists → verify message retrievable via GET sessions/:id/messages → verify WebSocket broadcast fires in `apps/api/tests/integration/message-persistence-flow.test.ts`
- [x] T028 [US1] Remove browser-side message persistence writes: remove or disable the code paths in chat-persistence.ts that POST messages to the DO (keep read/create/stop session functions) in `apps/api/src/services/chat-persistence.ts`
- [x] T029 [US1] Remove browser-side persistence calls from web components that currently invoke persistMessage/persistMessageAsync — browser becomes read-only for chat history in `apps/web/src/` (identify and update relevant components)

**Checkpoint**: US1 complete. All workspace chat messages persist via the VM agent. Browser disconnection causes zero message loss. Messages survive workspace destruction. Transient network failures are retried with backoff.

---

## Phase 4: User Story 2 — Submit a Task and Run It Immediately (Priority: P1)

**Goal**: User types a task on the project page, clicks "Run Now," and the system creates a task, provisions a workspace, executes the agent, persists chat history, and auto-cleans up on completion.

**Independent Test**: Submit a task from the project page, watch messages appear in real-time, verify workspace cleaned up and git branch created after completion.

**Covers**: FR-008 through FR-016

### Task Runner Chat Session Integration

- [ ] T030 [US2] Enhance `executeTaskRun()`: after workspace creation, create chat session in ProjectData DO via `createSession(workspaceId, task.title, taskId)`, include `chatSessionId` in cloud-init variables, set `output_branch` to `task/{taskId}` format in `apps/api/src/services/task-runner.ts`
- [ ] T031 [US2] Unit tests for task runner chat session creation in `apps/api/tests/unit/task-runner-session.test.ts` — **Scenarios**: (1) executeTaskRun creates chat session with correct taskId and title, (2) chatSessionId included in cloud-init variables, (3) output_branch set to task/{taskId} format, (4) task description persisted as first user-role message in session, (5) project without projectId skips session creation gracefully, (6) session creation failure fails the task with descriptive error

### Task Completion Flow

- [ ] T032 [US2] Implement task completion callback handling: on clean ACP completion auto-destroy workspace via stopWorkspaceOnNode(), transition task to completed, record output_branch and optional PR URL in task output metadata in `apps/api/src/services/task-runner.ts`
- [ ] T033 [US2] Unit tests for task completion in `apps/api/tests/unit/task-runner-completion.test.ts` — **Scenarios**: (1) clean completion destroys workspace, transitions task to completed, (2) clean completion records output_branch in task metadata, (3) agent failure keeps workspace alive, transitions task to failed with error message, (4) user cancellation keeps workspace alive, transitions task to cancelled, (5) git push failure transitions to completed with warning (workspace NOT destroyed), (6) completion stops the chat session in ProjectData DO, (7) concurrent completion callbacks are idempotent

### Task Callback Endpoint

- [ ] T034 [US2] Implement VM agent task completion callback endpoint (or extend existing workspace callback) for the agent to report clean completion, failure, or output metadata in `apps/api/src/routes/workspaces.ts`
- [ ] T035 [US2] Unit tests for task callback endpoint in `apps/api/tests/unit/task-callback.test.ts` — **Scenarios**: (1) valid completion callback triggers cleanup flow, (2) failure callback records error and keeps workspace, (3) callback JWT auth validated, (4) workspace not found returns 404, (5) callback for non-task workspace is no-op for task lifecycle

### Integration Validation

- [ ] T036 [US2] Integration test: task run lifecycle end-to-end in `apps/api/tests/integration/task-run-lifecycle.test.ts` — **Scenarios**: (1) submit task → task queued → workspace created → session created → task in_progress → completion callback → workspace destroyed → task completed with output_branch, (2) submit task → provision failure → task failed with error message

**Checkpoint**: US2 complete. Users can submit tasks that auto-provision workspaces, execute, persist full chat history, and auto-clean up. Failed tasks preserve workspaces for inspection.

---

## Phase 5: User Story 6 — Warm Node Pooling for Fast Task Startup (Priority: P2)

**Goal**: After a task completes and its workspace is destroyed, the node stays alive for 30 minutes. New tasks reuse warm nodes for fast startup. Expired nodes are automatically cleaned up with a three-layer defense (DO alarm + cron sweep + max lifetime).

**Independent Test**: Run a task to completion, immediately run another task, verify it reuses the same node. Wait 30+ minutes, verify the node is cleaned up.

**Covers**: FR-017 through FR-021

### NodeLifecycle Durable Object

- [ ] T037 [P] [US6] Implement NodeLifecycle Durable Object class with markIdle(nodeId, userId), markActive(), tryClaim(taskId), getStatus(), and alarm() methods. Uses DO storage for state, setAlarm() for timeout, deleteAlarm() for cancellation. alarm() initiates node destruction (Hetzner delete, DNS cleanup, D1 update) with retry on failure in `apps/api/src/durable-objects/node-lifecycle.ts`
- [ ] T038 [US6] Unit tests for NodeLifecycle DO (EXHAUSTIVE — >90% coverage) in `apps/api/tests/unit/node-lifecycle.test.ts` — **Scenarios**: (1) markIdle sets status='warm', stores nodeId/userId, schedules alarm at now+timeout, (2) markIdle when already warm resets alarm to new timeout, (3) markIdle when destroying throws node_lifecycle_conflict, (4) markActive sets status='active', clears claimedByTask, cancels alarm via deleteAlarm, (5) markActive updates D1 warm_since=null, (6) tryClaim on warm node returns true, sets active, sets claimedByTask, cancels alarm, (7) tryClaim on active node returns false with no side effects, (8) tryClaim on destroying node returns false, (9) sequential tryClaim: first succeeds, second fails (simulates concurrent), (10) alarm fires on warm node: sets destroying, initiates cleanup, (11) alarm no-op when node is active (was claimed between schedule and fire), (12) alarm retry: destruction failure schedules new alarm at +1min, (13) getStatus returns correct nodeId/status/warmSince/claimedByTask for each state, (14) D1 warm_since updated on markIdle (set) and markActive/tryClaim (cleared)

### Infrastructure Configuration

- [ ] T039 [US6] Add NodeLifecycle DO binding to wrangler.toml (durable_objects section) and export class in `apps/api/wrangler.toml` and `apps/api/src/index.ts`
- [ ] T040 [US6] Add NodeLifecycle DO namespace to Pulumi infrastructure stack in `infra/index.ts`

### Node Selector Enhancement

- [ ] T041 [US6] Update `selectNodeForTaskRun()` to query D1 for warm nodes (warm_since IS NOT NULL), attempt `tryClaim(taskId)` on each via NodeLifecycle DO, return first claimed node. Fall through to existing capacity-based selection if no warm node claimed in `apps/api/src/services/node-selector.ts`
- [ ] T042 [US6] Unit tests for warm node selection in `apps/api/tests/unit/node-selector-warm.test.ts` — **Scenarios**: (1) warm node available and tryClaim succeeds — returns warm node, (2) warm node available but tryClaim fails (concurrent claim) — falls through to capacity check, (3) no warm nodes in D1 — uses existing selection logic, (4) multiple warm nodes — tries each in order until one claims, (5) warm node preferred over provisioning new node, (6) warm node size/location matching still applies

### Task Runner Node Warm Integration

- [ ] T043 [US6] Enhance task runner completion: after workspace destruction, count remaining active workspaces on node — if zero, call NodeLifecycle.markIdle(nodeId, userId) in `apps/api/src/services/task-runner.ts`
- [ ] T044 [US6] Unit tests for node warm marking in `apps/api/tests/unit/task-runner-warm.test.ts` — **Scenarios**: (1) last workspace destroyed on node — markIdle called, (2) other workspaces remain on node — markIdle NOT called, (3) markIdle failure logged but does not fail task completion, (4) non-auto-provisioned node skips warm pooling

### Cron Reconciliation Sweep

- [ ] T045 [US6] Implement cron handler for node cleanup sweep: query D1 for stale warm nodes (warm_since < now - grace period), verify no active workspaces, destroy if confirmed empty. Also enforce max auto-provisioned node lifetime in `apps/api/src/scheduled/node-cleanup.ts`
- [ ] T046 [US6] Unit tests for cron sweep in `apps/api/tests/unit/node-cleanup.test.ts` — **Scenarios**: (1) stale warm node (past grace period) with no workspaces — destroyed, (2) warm node within grace period — preserved, (3) warm node with active workspaces — skipped (not destroyed), (4) node exceeding MAX_AUTO_NODE_LIFETIME_MS — destroyed regardless, (5) idempotent: running sweep twice has no double-destroy, (6) empty D1 query results — no-op, (7) destruction failure logged but sweep continues to next node
- [ ] T047 [US6] Add cron trigger to wrangler.toml: `*/15 * * * *` schedule for node cleanup sweep in `apps/api/wrangler.toml`

### Integration Validation

- [ ] T048 [US6] Integration test: warm node pooling lifecycle in `apps/api/tests/integration/warm-node-pooling.test.ts` — **Scenarios**: (1) task completes → workspace destroyed → node marked warm → new task claims warm node (fast startup), (2) warm node timeout expires → alarm fires → node destroyed, (3) cron sweep catches stale node missed by alarm

**Checkpoint**: US6 complete. Nodes stay warm for 30 minutes after tasks complete. Subsequent tasks reuse warm nodes. Three-layer defense ensures no orphaned nodes (DO alarm + cron sweep + max lifetime).

---

## Phase 6: User Story 3 — Project-Level Chat View as Default Experience (Priority: P1)

**Goal**: Project page defaults to a chat-first view with session sidebar (left) and message panel (center). Active sessions show real-time messages via DO WebSocket. Historical sessions show full transcripts. Users can navigate between sessions and open live workspaces.

**Independent Test**: Navigate to a project with multiple past sessions, verify most recent session loads by default, scroll through messages, switch sessions in sidebar, confirm active sessions show real-time updates.

**Covers**: FR-022 through FR-027

### API Client & Shared UI Components

- [ ] T049 [P] [US3] Add API client functions: `listSessionsWithTaskFilter(projectId, taskId?)`, `getSessionMessages(projectId, sessionId, opts?)`, `connectProjectWebSocket(projectId)` returning typed WebSocket wrapper in `apps/web/src/lib/api.ts`
- [ ] T050 [P] [US3] Create SplitButton reusable component — primary action button with dropdown chevron that opens a menu of secondary actions (GitHub PR-style split button) in `apps/web/src/components/ui/SplitButton.tsx`
- [ ] T051 [US3] Unit tests for SplitButton in `apps/web/src/components/ui/SplitButton.test.tsx` — **Scenarios**: (1) renders with primary label and dropdown chevron, (2) primary click fires onPrimaryAction callback, (3) chevron click opens dropdown menu, (4) dropdown option click fires option callback and closes menu, (5) Escape key closes dropdown, (6) disabled state prevents all interactions, (7) click outside closes dropdown

### Session Sidebar

- [ ] T052 [US3] Implement SessionSidebar: fetches sessions via API, displays in reverse chronological order, shows topic/status/task title/timestamp, highlights selected session, emits onSelect callback in `apps/web/src/components/chat/SessionSidebar.tsx`
- [ ] T053 [US3] Unit tests for SessionSidebar in `apps/web/src/components/chat/SessionSidebar.test.tsx` — **Scenarios**: (1) renders sessions in reverse chronological order, (2) active session shows pulsing/live indicator, (3) task-linked session shows task title badge, (4) selected session highlighted with active style, (5) click fires onSelect with sessionId, (6) empty state shows "No sessions yet" message, (7) loading state shows skeleton/spinner, (8) session with destroyed workspace shows archive indicator

### Message Viewer with Real-Time Updates

- [ ] T054 [US3] Implement ProjectMessageView: fetches messages for selected session, renders with role indicators (user/assistant/tool) and timestamps, auto-scrolls to bottom on new messages, connects to ProjectData DO WebSocket for `message.new` events on active sessions, shows "Open Workspace" link for sessions with running workspaces in `apps/web/src/components/chat/ProjectMessageView.tsx`
- [ ] T055 [US3] Unit tests for ProjectMessageView in `apps/web/src/components/chat/ProjectMessageView.test.tsx` — **Scenarios**: (1) renders messages with correct role indicators, (2) tool messages show tool_metadata (tool name, target, status), (3) auto-scrolls to bottom when new message added, (4) empty session shows empty state, (5) loading state shows skeleton, (6) WebSocket message.new event appends message to view, (7) "Open Workspace" link visible for active workspace sessions, (8) destroyed workspace shows indicator without "Open Workspace" link, (9) timestamps formatted as relative time

### Page Assembly & Routing

- [ ] T056 [US3] Create ProjectChat page combining SessionSidebar + ProjectMessageView + TaskSubmitForm slot (form wired in Phase 7), with responsive layout (sidebar collapsible on mobile) in `apps/web/src/pages/ProjectChat.tsx`
- [ ] T057 [US3] Update Project.tsx: change default sub-route to chat view, add view switcher toggle (Chat / Board) that preserves selected session and scroll position across switches in `apps/web/src/pages/Project.tsx`
- [ ] T058 [US3] Update App.tsx routes: default `/projects/:id` to chat view, add `/projects/:id/chat/:sessionId?` for deep-linking to specific sessions in `apps/web/src/App.tsx`

**Checkpoint**: US3 complete. Project page defaults to chat view. Sessions listed in sidebar. Messages displayed with role indicators. Active sessions update in real-time via DO WebSocket. Users can navigate sessions and open live workspaces.

---

## Phase 7: User Story 4 + User Story 5 — Save Task to Backlog & Task Kanban Board (Priority: P2)

**Goal**: Users can save tasks to backlog (draft status) via split-button dropdown. Kanban board shows tasks organized by status columns. Cards link to chat sessions. View switching between chat and kanban is seamless.

**Independent Test (US4)**: Type a task, select "Save to Backlog" from dropdown, verify task appears in draft column of kanban board, edit it, trigger execution from board.

**Independent Test (US5)**: Create tasks in different statuses, switch to kanban view, verify columns and cards render, click card to navigate to chat session.

**Covers**: FR-028 through FR-035

### Task Submit Form

- [ ] T059 [P] [US4] Implement TaskSubmitForm with SplitButton: "Run Now" as primary action (creates task + triggers run), "Save to Backlog" as dropdown option (creates draft task). Include expandable advanced options (priority, agent hint) collapsed by default. Validate cloud credentials before "Run Now" in `apps/web/src/components/task/TaskSubmitForm.tsx`
- [ ] T060 [US4] Unit tests for TaskSubmitForm in `apps/web/src/components/task/TaskSubmitForm.test.tsx` — **Scenarios**: (1) "Run Now" creates task and calls run API, (2) "Save to Backlog" creates task with draft status, (3) empty description shows validation error, (4) no cloud credentials shows error directing to settings, (5) advanced options toggle expands/collapses section, (6) loading state disables submit during API call, (7) successful submission clears input, (8) error from API shows toast notification

### Kanban Board

- [ ] T061 [P] [US5] Implement TaskKanbanBoard: fetches tasks, renders columns for primary statuses (draft, ready, in_progress, completed, failed, cancelled). Transient statuses (queued, delegated) shown as badges on cards, not separate columns — unless transient items exist, then dynamic columns appear in `apps/web/src/components/task/TaskKanbanBoard.tsx`
- [ ] T062 [P] [US5] Implement TaskKanbanCard: displays task title, status badge, workspace indicator (spinner if active), linked session indicator, click navigates to chat view with task's session selected in `apps/web/src/components/task/TaskKanbanCard.tsx`
- [ ] T063 [US5] Unit tests for kanban components in `apps/web/src/components/task/TaskKanban.test.tsx` — **Scenarios**: (1) renders columns for all 6 primary statuses, (2) tasks placed in correct column by status, (3) transient status (queued) shows as spinner badge on card in in_progress column, (4) transient column appears dynamically when items exist, (5) card shows title and status badge, (6) card click navigates to /projects/:id/chat/:sessionId, (7) empty column renders with placeholder, (8) tasks sorted by priority within columns, (9) active workspace shows spinner indicator on card

### Page Integration

- [ ] T064 [US5] Create ProjectKanban page wrapping TaskKanbanBoard with project context in `apps/web/src/pages/ProjectKanban.tsx`
- [ ] T065 [US4] Wire TaskSubmitForm into ProjectChat page at the bottom of the message panel in `apps/web/src/pages/ProjectChat.tsx`
- [ ] T066 [US4+US5] Verify view switching preserves state: selected session in chat view maintained when switching to kanban and back, kanban scroll position preserved when switching to chat and back in `apps/web/src/pages/Project.tsx`

**Checkpoint**: US4 + US5 complete. Users can save tasks to backlog via split-button. Kanban board shows tasks by status. Cards link to chat sessions. View switching is seamless with preserved state.

---

## Phase 8: User Story 7 — Project-Level Default VM Size (Priority: P3)

**Goal**: Users configure a default VM size per project. Task runs use the project default unless explicitly overridden. Data model supports future per-profile overrides.

**Independent Test**: Set project default to "large," submit task without specifying size, verify provisioned node is large. Submit with explicit "small" override, verify it uses small.

**Covers**: FR-036 through FR-038

- [ ] T067 [US7] Add `defaultVmSize` field to PATCH `/api/projects/:projectId` endpoint — validate as 'small' | 'medium' | 'large' | null in `apps/api/src/routes/projects.ts`
- [ ] T068 [US7] Unit tests for project default VM size in `apps/api/tests/unit/project-vm-size.test.ts` — **Scenarios**: (1) PATCH with defaultVmSize='large' stores correctly, (2) PATCH with defaultVmSize=null clears to system default, (3) invalid size value returns 400, (4) GET project returns defaultVmSize, (5) task run with no vmSize override reads project default, (6) task run with explicit vmSize override ignores project default, (7) project without defaultVmSize falls back to platform default ('small')
- [ ] T069 [US7] Update task runner: read project's defaultVmSize when no vmSize specified in task run request — precedence: explicit override > project default > platform default ('small') in `apps/api/src/services/task-runner.ts`
- [ ] T070 [US7] Add VM size selector to project settings page — dropdown with small/medium/large options, save on change in `apps/web/src/components/project/` (appropriate settings component)

**Checkpoint**: US7 complete. Projects have configurable default VM size. Task runs respect the hierarchy: explicit override > project default > platform default.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Documentation updates, E2E testing, constitution validation, and final quality checks.

- [ ] T071 [P] Update CLAUDE.md: add new Active Technologies (cenkalti/backoff/v5), document NodeLifecycle DO, update Key Concepts with warm node pooling in `CLAUDE.md`
- [ ] T072 [P] Update self-hosting guide with new env vars (NODE_WARM_TIMEOUT_MS, MAX_AUTO_NODE_LIFETIME_MS, MSG_* vars), NodeLifecycle DO binding, and cron trigger configuration in `docs/guides/self-hosting.md`
- [ ] T073 [P] Update `.env.example` with all new control plane env vars and their defaults in `apps/api/.env.example`
- [ ] T074 E2E Playwright test: task submission flow — navigate to project, type task description, click "Run Now," verify task appears in session sidebar, verify messages flow in message panel, verify kanban board shows task progression in `apps/web/tests/e2e/task-submission.spec.ts`
- [ ] T075 E2E Playwright test: chat navigation — navigate to project with multiple sessions, verify default session loads, switch sessions via sidebar, verify message content changes, verify active session shows real-time indicator in `apps/web/tests/e2e/chat-navigation.spec.ts`
- [ ] T076 Run quickstart.md validation: follow all steps in `specs/021-task-chat-architecture/quickstart.md` and verify accuracy against final implementation
- [ ] T077 Constitution validation (Principle XI): audit all new code for hardcoded URLs, timeouts, limits, and identifiers — verify all are configurable via env vars with documented defaults

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup)
    │
    v
Phase 2 (Foundational) ← BLOCKS all user stories
    │
    ├──> Phase 3 (US1: Agent Persistence) ← BLOCKS US2, US3
    │       │
    │       ├──> Phase 4 (US2: Task Run) ← BLOCKS US6 completion flow
    │       │       │
    │       │       └──> Phase 5 (US6: Warm Pooling) *
    │       │
    │       └──> Phase 6 (US3: Chat UI) ← BLOCKS US4/US5
    │               │
    │               └──> Phase 7 (US4+US5: Kanban/Backlog)
    │
    └──> Phase 8 (US7: VM Size) ← can parallel after Phase 2+4
    
Phase 9 (Polish) ← after all stories complete

* Phase 5 NodeLifecycle DO (T037-T038) can START after Phase 2,
  but completion flow integration (T043-T044) depends on Phase 4.
```

### User Story Dependencies

- **US1 (P1)**: Depends on Foundational (Phase 2) only. No other story dependencies.
- **US2 (P1)**: Depends on US1 (needs chat session creation + persistence working).
- **US3 (P1)**: Depends on US1 (needs persisted messages to display). Can parallel with US2.
- **US4 (P2)**: Depends on US3 (extends project page with submit form).
- **US5 (P2)**: Depends on US3 (extends project page with kanban view). Can parallel with US4.
- **US6 (P2)**: NodeLifecycle DO is independent after Phase 2. Task runner integration depends on US2.
- **US7 (P3)**: Depends on Phase 2 (D1 migration) + US2 (task runner).

### Within Each Phase

- Tests marked with specific scenarios MUST be written and verified to FAIL before implementation
- Shared types and migrations before DO/service changes
- DO methods before API endpoints that use them
- API endpoints before Go agent code that calls them
- Core implementation before integration hooks
- Integration tests after all components are individually tested
- Browser-side deprecation ONLY after integration test passes

### Parallel Opportunities

**Phase 1** (all [P] tasks run simultaneously):
```
T002 (D1 migration: default_vm_size)  ║  T003 (D1 migration: warm_since)
T005 (Go dependency)                   ║  T006 (cloud-init interface)
T007 (WebSocket event types)
```

**Phase 3** (within US1):
```
T018 (config.go)  ║  T019 (schema.go)    # parallel — different files
```

**Phase 5** (within US6):
```
T037 (NodeLifecycle DO)  ║  alongside Phase 6 T049-T050 (API client, SplitButton)
```

**Phase 7** (within US4+US5):
```
T059 (TaskSubmitForm)  ║  T061 (KanbanBoard)  ║  T062 (KanbanCard)
```

---

## Parallel Example: Phase 2 Foundational

```bash
# After Phase 1 completes, launch these in parallel groups:

# Group A: ProjectData DO changes (sequential within group)
T008 → T009 → T010 → T011

# Group B: Cloud-init (parallel with Group A)
T012 → T013

# Group C: API endpoint (after T010 completes — needs persistMessageBatch)
T014 → T015

# Group D: Workspace creation hook (after T008 + T012)
T016 → T017
```

## Parallel Example: Phase 3 US1

```bash
# TDD: write reporter tests first
T021 (reporter_test.go — all 17 scenarios, expect FAIL)

# Then implement in parallel:
T018 (config.go)  ║  T019 (schema.go)

# Then core reporter (depends on config + schema):
T020 (reporter.go — run T021 tests, expect PASS)

# Then ACP integration:
T022 (extractMessages) → T023 (tests) → T024 (hook) → T025 (tests)

# Then startup + integration:
T026 (main init) → T027 (integration test)

# Finally deprecation:
T028 → T029
```

---

## Implementation Strategy

### MVP First (US1 Only — Agent-Side Persistence)

1. Complete Phase 1: Setup (shared types, migrations)
2. Complete Phase 2: Foundational (DO changes, cloud-init, API endpoint)
3. Complete Phase 3: US1 (Go reporter, session hook, browser deprecation)
4. **STOP AND VALIDATE**: Deploy to staging. Start a workspace, send messages, close browser, reopen project page — verify zero message loss.
5. This alone delivers the foundational architecture fix.

### Incremental Delivery

1. **Setup + Foundational** → Infrastructure ready
2. **+ US1** (Agent Persistence) → Messages persist without browser. Deploy/validate.
3. **+ US2** (Task Run) → Users submit tasks that auto-execute. Deploy/validate.
4. **+ US3** (Chat UI) → Project page shows chat history. Deploy/validate.
5. **+ US6** (Warm Pooling) → Fast startup for sequential tasks. Deploy/validate.
6. **+ US4/US5** (Kanban/Backlog) → Task management board. Deploy/validate.
7. **+ US7** (VM Size) → Project-level defaults. Deploy/validate.
8. **Polish** → Docs, E2E, constitution check. Final deploy.

Each increment adds value without breaking previous stories. Each is independently deployable and testable.

---

## Notes

- **[P]** tasks = different files, no dependencies on incomplete tasks
- **[Story]** label maps task to specific user story for traceability
- **Test scenarios** are specific and enumerated — not "add tests" handwaving
- **Critical paths** (message outbox, batch endpoint, NodeLifecycle DO, task completion) have >90% coverage via exhaustive test scenarios
- **Integration tests** are separate tasks from unit tests (T027, T036, T048)
- **E2E tests** are separate tasks in the Polish phase (T074, T075)
- **Browser deprecation** (T028-T029) is the LAST task in US1 — only after integration test T027 passes
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- All env vars configurable with defaults per Principle XI
