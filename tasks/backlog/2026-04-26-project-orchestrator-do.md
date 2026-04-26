# Project Orchestrator Durable Object (Phase 3)

## Problem Statement

SAM's orchestration system has Phase 1 (durable messaging/mailbox — PR #818) and Phase 2 (mission state/handoff packets — PR #819) merged. Phase 3 builds the **ProjectOrchestrator** Durable Object — a per-project "brain" that coordinates all agent work within a project. Today agents are dispatched and run independently; the orchestrator adds intelligent coordination: watching missions, managing task scheduling, sending durable messages, and making reactive decisions.

## Research Findings

### Existing Infrastructure (Phase 1 & 2)

**Phase 1 — Durable Messaging:**
- `session_inbox` table in ProjectData DO SQLite extended with mailbox columns (migration 017)
- 5 message classes: notify, deliver, interrupt, preempt_and_replan, shutdown_with_final_prompt
- Delivery state machine: queued → delivered → acked → expired
- MCP tools: `send_durable_message`, `get_pending_messages`, `ack_message` in `apps/api/src/routes/mcp/mailbox-tools.ts`
- Service wrapper: `apps/api/src/services/project-data.ts:649-717`
- DO alarm integration: `computeMailboxAlarmTime()` feeds into `recalculateAlarm()`

**Phase 2 — Missions & Handoffs:**
- D1 `missions` table (migration 0048): id, project_id, user_id, title, status, root_task_id, budget_config
- Tasks table: `mission_id` FK (ON DELETE SET NULL), `scheduler_state` nullable column
- `task_dependencies` D1 table: taskId, dependsOnTaskId
- ProjectData DO SQLite (migration 018): `mission_state_entries`, `handoff_packets` tables
- Pure function: `computeSchedulerStates()` in `apps/api/src/services/scheduler-state.ts`
- Sync function: `recomputeMissionSchedulerStates()` in `apps/api/src/services/scheduler-state-sync.ts`
- MCP tools in `apps/api/src/routes/mcp/mission-tools.ts`: create_mission, get_mission, publish_mission_state, get_mission_state, publish_handoff, get_handoff
- Shared types: `packages/shared/src/types/mission.ts`
- Constants: `packages/shared/src/constants/missions.ts`

### Existing DO Patterns

- DOs extend `DurableObject<Env>`, export from `apps/api/src/index.ts`
- Binding in `wrangler.toml` top-level section + `[[migrations]]` tag for new classes
- Env type in `apps/api/src/env.ts` lists all DO namespace bindings
- Alarm pattern: `ctx.storage.setAlarm(timestamp)`, `alarm()` handler dispatches based on state
- State persistence: `ctx.storage.put('state', {...})` for idempotency
- Service layer pattern: functions in `apps/api/src/services/` wrap DO stub calls
- TaskRunner keyed by taskId, ProjectData by projectId, NodeLifecycle by nodeId

### Task Dispatch Infrastructure

- `handleDispatchTask()` in `apps/api/src/routes/mcp/dispatch-tool.ts` creates D1 task row + starts TaskRunnerDO
- `startTaskRunnerDO()` in `apps/api/src/services/task-runner-do.ts` bridges routes to DO
- TaskRunner step flow: node_selection → node_provisioning → workspace_creation → agent_session → running
- After dispatch and completion, `recomputeMissionSchedulerStates()` is called to update sibling states

### Key Files

| Component | File |
|-----------|------|
| Env type (DO bindings) | `apps/api/src/env.ts:38-46` |
| Worker exports | `apps/api/src/index.ts:2-10` |
| wrangler DO bindings | `apps/api/wrangler.toml:92-134` |
| Scheduler state (pure) | `apps/api/src/services/scheduler-state.ts` |
| Scheduler state sync | `apps/api/src/services/scheduler-state-sync.ts` |
| Task dispatch | `apps/api/src/routes/mcp/dispatch-tool.ts` |
| Task runner DO | `apps/api/src/durable-objects/task-runner/index.ts` |
| Task runner service | `apps/api/src/services/task-runner-do.ts` |
| Mailbox DO module | `apps/api/src/durable-objects/project-data/mailbox.ts` |
| Mission DO module | `apps/api/src/durable-objects/project-data/missions.ts` |
| Mailbox MCP tools | `apps/api/src/routes/mcp/mailbox-tools.ts` |
| Mission MCP tools | `apps/api/src/routes/mcp/mission-tools.ts` |
| Mission types | `packages/shared/src/types/mission.ts` |
| Mission constants | `packages/shared/src/constants/missions.ts` |

## Implementation Checklist

### 1. Shared Types & Constants
- [ ] Add orchestrator types to `packages/shared/src/types/orchestrator.ts` (OrchestratorStatus, OrchestratorMissionState, SchedulingDecision, DecisionLogEntry)
- [ ] Add orchestrator constants to `packages/shared/src/constants/orchestrator.ts` (configurable defaults for scheduling interval, stall timeout, max concurrent tasks, retry limits)
- [ ] Export from shared package index

### 2. ProjectOrchestrator Durable Object
- [ ] Create `apps/api/src/durable-objects/project-orchestrator/index.ts` — main DO class
- [ ] Internal SQLite schema: `orchestrator_missions` (active missions tracking, last_checked_at), `scheduling_queue` (pending dispatches), `decision_log` (audit trail of orchestrator decisions)
- [ ] `alarm()` handler: scheduling loop (load active missions → check completions → route handoffs → recompute states → dispatch schedulable → detect stalls)
- [ ] `start(missionId)` RPC: register a mission for orchestration, arm initial alarm
- [ ] `pause(missionId)` / `resume(missionId)` / `cancel(missionId)` RPCs: mission lifecycle
- [ ] `getStatus()` RPC: return current orchestrator state (active missions, scheduling queue, recent decisions)
- [ ] `getSchedulingQueue()` RPC: return tasks waiting to be dispatched
- [ ] `overrideTaskState(taskId, newState)` RPC: allow human to force a scheduler state
- [ ] `notifyTaskEvent(taskId, event)` RPC: hook called when task completes/fails — triggers scheduling cycle

### 3. Scheduling Logic
- [ ] On alarm: iterate active missions, call `recomputeMissionSchedulerStates()` for each
- [ ] Identify newly `schedulable` tasks (were blocked, now schedulable) and auto-dispatch via `startTaskRunnerDO()`
- [ ] Read handoff packets from completed predecessor tasks, route to dependent tasks via `enqueueMailboxMessage()` with `deliver` class
- [ ] Check concurrency limits from mission `budget_config.maxActiveTasks` before dispatching
- [ ] Detect stalled tasks: running tasks with no status event for configurable duration → send `interrupt` message
- [ ] Log all scheduling decisions to `decision_log` table for auditability
- [ ] Re-arm alarm for next cycle (configurable interval, default 30s)

### 4. Wrangler & Env Configuration
- [ ] Add `PROJECT_ORCHESTRATOR` binding to `apps/api/wrangler.toml` top-level DO section
- [ ] Add `[[migrations]] tag = "v10" new_sqlite_classes = ["ProjectOrchestrator"]`
- [ ] Add `PROJECT_ORCHESTRATOR: DurableObjectNamespace` to `Env` interface
- [ ] Add configurable env vars to `Env`: ORCHESTRATOR_SCHEDULING_INTERVAL_MS, ORCHESTRATOR_STALL_TIMEOUT_MS, ORCHESTRATOR_MAX_CONCURRENT_DISPATCHES, ORCHESTRATOR_DECISION_LOG_MAX_ENTRIES
- [ ] Export class from `apps/api/src/index.ts`

### 5. Service Layer
- [ ] Create `apps/api/src/services/project-orchestrator.ts` — service wrapper for DO stub calls
- [ ] Functions: startOrchestration, pauseMission, resumeMission, cancelMission, getOrchestratorStatus, getSchedulingQueue, overrideTaskState, notifyTaskEvent

### 6. REST API Routes
- [ ] Create `apps/api/src/routes/orchestrator.ts` with project-scoped routes:
  - `GET /api/projects/:projectId/orchestrator/status` — orchestrator status
  - `GET /api/projects/:projectId/orchestrator/queue` — scheduling queue
  - `POST /api/projects/:projectId/orchestrator/missions/:missionId/pause` — pause mission
  - `POST /api/projects/:projectId/orchestrator/missions/:missionId/resume` — resume mission
  - `POST /api/projects/:projectId/orchestrator/missions/:missionId/cancel` — cancel mission
  - `POST /api/projects/:projectId/orchestrator/tasks/:taskId/override` — override task state
- [ ] Register routes in main app

### 7. MCP Tools
- [ ] Create `apps/api/src/routes/mcp/orchestrator-tools.ts` with tools:
  - `get_orchestrator_status` — current orchestrator state for this project
  - `pause_mission` — pause a mission's scheduling
  - `resume_mission` — resume a paused mission
  - `cancel_mission` — cancel a mission and all its schedulable tasks
  - `override_task_state` — force a task's scheduler state
  - `get_scheduling_queue` — see what's pending dispatch
- [ ] Register tools in MCP tool definitions and handler

### 8. Integration: Hook Task Events
- [ ] In `complete_task` MCP handler: call `notifyTaskEvent()` on ProjectOrchestrator DO after status update
- [ ] In `update_task_status` MCP handler: call `notifyTaskEvent()` for terminal statuses
- [ ] In `create_mission` MCP handler: call `startOrchestration()` on ProjectOrchestrator DO
- [ ] Ensure non-mission tasks are completely unaffected (guard on mission_id != null)

### 9. Tests
- [ ] Unit tests for scheduling logic (schedulable tasks dispatched, blocked tasks held, stall detection)
- [ ] Unit tests for handoff routing (completed task → handoff packet → durable message to dependent)
- [ ] Unit tests for concurrency limits (max active tasks respected)
- [ ] Unit tests for mission lifecycle (pause stops dispatching, resume re-arms, cancel cancels pending)
- [ ] Capability test: task A completes → handoff routed → task B auto-dispatched (cross-boundary)
- [ ] Test that non-mission tasks are unaffected by orchestrator

### 10. Documentation
- [ ] Update CLAUDE.md Recent Changes section
- [ ] Update env var documentation

## Acceptance Criteria

- [ ] ProjectOrchestrator DO created, bound in wrangler.toml, exported from index.ts
- [ ] Scheduling loop runs on alarm, processes task completions, recomputes states
- [ ] Dependent tasks auto-dispatch when predecessors complete (if schedulable and within limits)
- [ ] Handoff packets routed from completing task to dependent tasks via durable messages
- [ ] Stall detection sends interrupt messages after configurable timeout
- [ ] Human-blocked tasks surfaced correctly (blocked_human state preserved)
- [ ] MCP tools for orchestrator interaction (status, pause, resume, cancel, override, queue)
- [ ] REST API for orchestrator status and scheduling visibility
- [ ] Capability test: task A completes → handoff routed → task B auto-dispatched
- [ ] Existing non-mission task workflows completely unaffected
- [ ] All intervals/timeouts/limits configurable via env vars (Constitution XI)

## References

- Vision document: `strategy/orchestration/sam-the-orchestrator.md` (project library)
- Phase 1 PR #818: durable messaging layer
- Phase 2 PR #819: mission state and handoff packets
- Scheduler state: `apps/api/src/services/scheduler-state.ts`
- TaskRunner DO pattern: `apps/api/src/durable-objects/task-runner/`
