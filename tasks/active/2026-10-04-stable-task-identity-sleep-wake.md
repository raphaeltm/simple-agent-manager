# Stable Task Identity Across Sleep/Wake

## Problem

VM session wake currently creates a fresh `session-recovery` task and rebinds the chat session to that replacement. That breaks parent/child hierarchy, direct-child MCP checks, and per-parent dispatch budgets because the conversation changes task identity on every sleep/wake cycle.

## Research Findings

- `apps/api/src/services/session-recovery.ts` mints a ULID, claims snapshot recovery with it, inserts a replacement task, detaches the source task, and starts a replacement TaskRunner.
- `apps/api/src/durable-objects/project-data/sessions.ts` updates `chat_sessions.task_id` during wake; this is the ProjectData-side rebind that makes the UI and orchestration see a new task.
- `apps/api/src/services/session-recovery-task.ts` calls `startTaskRunnerDO()` for the replacement task; the TaskRunner DO is keyed by task id, so stable identity needs a reactivation path for the existing DO state.
- `apps/api/src/services/session-sleep-teardown.ts` makes workspaces, agent sessions, snapshots, and ProjectData sleep, but does not mark the backing task as sleeping.
- `packages/shared/src/types/task.ts`, `apps/api/src/services/task-status.ts`, and `apps/api/src/schemas/tasks.ts` maintain separate status lists that need `sleeping`.
- Existing tests under `apps/api/tests/integration/session-recovery-handoff.test.ts` and `apps/api/tests/unit/durable-objects/project-data-sessions-wake.test.ts` pin the old replacement/rebind behavior and need to be updated.

## Implementation Checklist

- [ ] Add `sleeping` to task status contracts and transitions while keeping terminal status unchanged.
- [ ] Mark the backing task `sleeping` during sleep teardown without setting supersession fields.
- [ ] Replace recovery-task creation with a reactivation claim that keeps `tasks.id`, `parent_task_id`, and `dispatch_depth` stable.
- [ ] Add TaskRunner reactivation support that restarts placement/runtime state for an existing sleeping conversation task.
- [ ] Stop updating ProjectData `chat_sessions.task_id` on wake.
- [ ] Update recovery and ProjectData tests to assert stable task identity, no new `session-recovery` rows, preserved lineage, and repeated wake behavior.
- [ ] Run focused tests and the repository quality gates.

## Acceptance Criteria

- A VM conversation keeps the same task id across one or more sleep/wake cycles.
- Sleep transitions the task to `sleeping`; wake transitions it back toward active execution without creating a recovery task.
- `parent_task_id` and `dispatch_depth` are preserved across wake.
- Existing recovery/supersession columns remain in schema for legacy data, but new wake cycles do not append recovery chains.
- ProjectData wake leaves `chat_sessions.task_id` unchanged.
- Tests cover stable identity and repeated wake behavior.
