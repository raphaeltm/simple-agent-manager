# Remediate ProjectOrchestrator mailbox targeting

## Problem Statement

A CTO spot check found that `ProjectOrchestrator` routes handoff and stall mailbox messages with task IDs in `targetSessionId`. ProjectData mailbox storage and retrieval are keyed by real chat session IDs, so messages queued under task IDs are not polled by agents. Handoffs to dependent agents and stall interrupts can therefore be durably queued but never delivered.

## Research Findings

- `apps/api/src/durable-objects/project-orchestrator/scheduling.ts` currently enqueues handoff `deliver` messages with `targetSessionId: depTaskId` and stall `interrupt` messages with `targetSessionId: task.id`.
- `apps/api/src/durable-objects/project-data/mailbox.ts` stores `session_inbox.target_session_id` and `getPendingMessages()` filters by `target_session_id = ?`.
- `apps/api/src/durable-objects/project-data/sessions.ts` stores task linkage in `chat_sessions.task_id` and already has `getSessionsByTaskIds(sql, taskIds)`.
- `apps/api/src/durable-objects/project-data/index.ts` and `apps/api/src/services/project-data.ts` already expose `getSessionsByTaskIds`, so scheduler code can use the existing ProjectData RPC/service path.
- Auto-dispatch already creates a chat session for the task and passes that same session ID to `startTaskRunnerDO`; tests should assert that mapping is preserved.
- Existing scheduler tests are weak around behavior: auto-dispatch mostly asserts no throw, stall detection only checks a decision row, and non-mission guard tests assert imports rather than behavior.
- Prior task records for ProjectOrchestrator and durable mailbox messaging emphasize cross-boundary behavior and durable delivery semantics; `.claude/rules/35-vertical-slice-testing.md` requires realistic boundary state and payload assertions.

## Implementation Checklist

- [x] Add a scheduler helper that resolves task IDs to active chat session IDs through `projectDataService.getSessionsByTaskIds`.
- [x] Use the helper for handoff routing so `deliver` messages target dependent tasks' real chat session IDs.
- [x] Use the helper for stall detection so `interrupt` messages target stalled tasks' real chat session IDs.
- [x] Log observable decision/warning entries for missing target sessions without writing mailbox rows under task IDs.
- [x] Replace untyped handoff handling with a local typed/validated shape and defensive content formatting.
- [x] Strengthen scheduler tests to assert handoff mailbox targets are session IDs and missing sessions skip enqueue with a decision.
- [x] Strengthen scheduler tests to assert stall mailbox targets are session IDs and missing sessions skip enqueue with a decision.
- [x] Strengthen auto-dispatch tests to assert `startTaskRunnerDO` receives the created chat session ID and task description is persisted to that session.
- [x] Replace import-only non-mission guard coverage with a behavioral `complete_task` assertion.
- [x] Keep changes scoped to ProjectOrchestrator scheduling, ProjectData service usage, and focused tests.
- [x] Run focused scheduler tests, API lint/typecheck/test, and the required `/do` validation/review gates.

## Acceptance Criteria

- [x] No orchestrator mailbox enqueue uses a task ID as `targetSessionId`.
- [x] Handoff and stall messages are addressed to real chat session IDs in tests and implementation.
- [x] Missing target sessions are observable through decision log or structured warning and do not create undeliverable mailbox rows under task IDs.
- [x] Scheduler tests fail on the current broken behavior and pass after the fix.
- [x] PR summary includes the original CTO spot-check finding and exact validation commands run.

## References

- `apps/api/src/durable-objects/project-orchestrator/index.ts`
- `apps/api/src/durable-objects/project-orchestrator/scheduling.ts`
- `apps/api/src/durable-objects/project-orchestrator/migrations.ts`
- `apps/api/src/services/project-orchestrator.ts`
- `apps/api/src/services/project-data.ts`
- `apps/api/src/durable-objects/project-data/mailbox.ts`
- `apps/api/src/durable-objects/project-data/sessions.ts`
- `apps/api/tests/unit/durable-objects/project-orchestrator-scheduling.test.ts`
- `apps/api/tests/workers/project-orchestrator-proxy.test.ts`
- `.claude/rules/35-vertical-slice-testing.md`
