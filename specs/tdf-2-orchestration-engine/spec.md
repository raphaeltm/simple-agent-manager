# Feature Specification: TDF-2 Orchestration Engine — Durable Object Migration

**Feature Branch**: `tdf-2-orchestration-engine`
**Created**: 2026-02-27
**Status**: Draft
**Input**: TDF-2 task definition + flow map analysis + task delegation system analysis

## Summary

Replace the unreliable `waitUntil()`-based task orchestration (`executeTaskRun()`) with a Durable Object (`TaskRunner DO`) that uses alarm-driven step execution. Each orchestration step becomes an independent, idempotent alarm callback with persisted state, eliminating the fundamental reliability problem where Worker recycling silently kills multi-minute orchestration pipelines.

## User Scenarios & Testing

### User Story 1 — Durable Task Execution (Priority: P1)

A user submits a task via the chat UI. Instead of the orchestration running in a fire-and-forget `waitUntil()`, a TaskRunner Durable Object is created for the task. The DO drives each step (node selection, provisioning, workspace creation, agent session) via alarm callbacks. If the Worker is recycled at any point, the DO's persisted state and alarm resume execution automatically — no 5-minute cron recovery delay.

**Why this priority**: This is the core value proposition — reliable task execution that survives Worker restarts.

**Independent Test**: Submit a task, verify each step transitions via DO alarms and the task reaches `in_progress`. Simulate Worker death mid-step and verify the DO alarm resumes execution.

**Acceptance Scenarios**:

1. **Given** a queued task, **When** the TaskRunner DO alarm fires, **Then** it executes the `node_selection` step, persists the selected nodeId, and schedules the next alarm.
2. **Given** a DO mid-provisioning, **When** the Worker is recycled, **Then** the DO alarm fires again and resumes from the persisted step — not from the beginning.
3. **Given** a step that fails transiently (e.g., Hetzner API timeout), **When** the alarm retries, **Then** it succeeds on retry without duplicating side effects.
4. **Given** a step that fails permanently, **When** max retries are exhausted, **Then** the task transitions to `failed` with a descriptive error.

### User Story 2 — Callback-Driven Advancement (Priority: P1)

When the workspace becomes ready on the VM, the `/workspaces/{id}/ready` callback advances the TaskRunner DO directly instead of relying on D1 polling. This eliminates the `waitForWorkspaceReady()` polling loop and the associated `waitUntil()` death window.

**Why this priority**: The polling loop is the #1 failure mode — Worker dies while polling, workspace is ready but nobody advances the task.

**Independent Test**: Create a workspace via DO, then fire the ready callback — verify the DO immediately advances to agent session creation without any polling.

**Acceptance Scenarios**:

1. **Given** a task at `workspace_ready` step, **When** the ready callback arrives, **Then** the DO advances to `agent_session` within milliseconds (no polling delay).
2. **Given** a task at `workspace_creation` step (before workspace_ready), **When** the ready callback arrives early, **Then** the callback is stored and processed when the DO reaches the `workspace_ready` step.
3. **Given** a task at `workspace_ready` step, **When** the ready callback does NOT arrive within the timeout, **Then** the DO alarm fires and fails the task with a descriptive timeout error.

### User Story 3 — Observability & Error Reporting (Priority: P2)

Every step transition is logged to Workers Observability. Failures are written to the OBSERVABILITY_DATABASE so they appear in the admin errors tab. The stuck-task cron becomes a safety net rather than the primary recovery mechanism.

**Why this priority**: Without observability, failures are invisible. The current system has a blind spot where `waitUntil()` deaths leave no trace.

**Independent Test**: Trigger a task failure at each step, verify the error appears in the observability database and admin UI.

**Acceptance Scenarios**:

1. **Given** a step failure in the DO, **When** the error is caught, **Then** an entry is written to OBSERVABILITY_DATABASE with source='api', level='error', and full context.
2. **Given** a successful step transition, **When** the DO advances, **Then** a structured log entry is emitted with step name, duration, and task context.
3. **Given** a DO-managed task, **When** the stuck-task cron runs, **Then** it detects DO-managed tasks and skips them (or only catches truly orphaned ones).

### User Story 4 — Graceful Migration (Priority: P2)

The migration from `waitUntil()` to DO-based orchestration is seamless. New tasks use the DO path. In-flight tasks under the old system complete normally. The stuck-task cron continues to serve as a safety net for both paths during the transition.

**Why this priority**: A safe rollout strategy prevents breaking existing functionality.

**Independent Test**: Submit a task, verify it uses the DO path. Verify the old `executeTaskRun` is no longer called from routes.

**Acceptance Scenarios**:

1. **Given** a new task submission, **When** it's created, **Then** a TaskRunner DO is instantiated and the first alarm fires — `waitUntil(executeTaskRun())` is NOT called.
2. **Given** existing in-flight tasks (pre-migration), **When** the new code deploys, **Then** those tasks continue under stuck-task cron recovery if needed.
3. **Given** the migration is complete, **When** all in-flight tasks finish, **Then** the old `executeTaskRun()` can be removed in a follow-up PR.

### Edge Cases

- What happens if the DO alarm fires but the external API (Hetzner) is down? → Retry with exponential backoff, fail after max retries.
- What happens if two callbacks arrive simultaneously (e.g., ready + error)? → DO processes them sequentially (single-threaded guarantee).
- What happens if a callback arrives for a task already in a terminal state? → Ignored (idempotent check).
- What happens if the DO storage is corrupted? → Task falls through to stuck-task cron safety net.
- What happens during deployment (new code, old DOs)? → DO state is backward-compatible; alarm handler checks state version.

## Requirements

### Functional Requirements

- **FR-001**: System MUST create a TaskRunner DO per task (keyed by taskId) when a task is submitted or manually run.
- **FR-002**: The TaskRunner DO MUST execute each orchestration step as an independent alarm callback, persisting results between steps.
- **FR-003**: Each step MUST be idempotent — re-executing a step produces the same result if the prior execution's side effects already happened.
- **FR-004**: The DO MUST handle workspace-ready callbacks by advancing the pipeline without polling.
- **FR-005**: The DO MUST distinguish transient failures (retry) from permanent failures (fail task).
- **FR-006**: The DO MUST write failures to OBSERVABILITY_DATABASE.
- **FR-007**: The DO MUST log each step transition to Workers Observability (structured logging).
- **FR-008**: The stuck-task cron MUST be updated to skip DO-managed tasks (or act as a safety net with longer timeouts).
- **FR-009**: All timeouts, retry counts, and backoff parameters MUST be configurable via environment variables with sensible defaults (Constitution Principle XI).
- **FR-010**: The `task-submit.ts` and `task-runs.ts` routes MUST wake the TaskRunner DO instead of calling `waitUntil(executeTaskRun())`.
- **FR-011**: The workspace ready callback (`/workspaces/{id}/ready` handler) MUST poke the TaskRunner DO to advance.
- **FR-012**: The DO MUST update D1 `tasks.executionStep` at each step for frontend polling compatibility.

### Key Entities

- **TaskRunner DO**: One per task (keyed by `taskId`). Stores current step, step results (nodeId, workspaceId), retry counts, and timestamps.
- **TaskRunnerState**: Persisted state including `currentStep`, `stepResults`, `retryCount`, `taskId`, `projectId`, `userId`, and configuration.
- **StepResult**: Per-step output (e.g., node_selection → `{ nodeId }`, workspace_creation → `{ workspaceId }`).

## Success Criteria

### Measurable Outcomes

- **SC-001**: Zero task failures caused by Worker recycling (currently the #1 failure mode).
- **SC-002**: Task step transitions visible in admin observability within 1 second of occurrence.
- **SC-003**: Workspace-ready advancement happens within 100ms of callback (vs. up to 10s polling delay).
- **SC-004**: All existing task functionality works identically from the user's perspective (no behavior regression).
- **SC-005**: Stuck-task cron recovery count drops to near-zero under normal operation (only fires for truly orphaned tasks).
- **SC-006**: 100% test coverage for DO step handlers, state transitions, and error paths.
