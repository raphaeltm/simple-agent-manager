# Fix Task Reconciliation Heartbeat Alarm Starvation

## Problem

Task-mode reconciliation was added so silent task agents receive a SAM orchestrator check-in after several minutes of inactivity. In production, task `01KRNE7Y5FR3J5JAXZ1J0FX063` remained `in_progress` with `task_mode='task'` and `execution_step='awaiting_followup'` even though it had stopped work and forgotten to call `complete_task()`.

The affected workspace node was still healthy and heartbeating. Code inspection shows that the full ProjectData alarm recomputation includes reconciliation, but the heartbeat fast path omits reconciliation from its alarm candidates. Healthy heartbeats can therefore keep rescheduling the Durable Object alarm and prevent the reconciliation check-in from firing.

## Research Findings

- `apps/api/src/durable-objects/project-data/index.ts`
  - `recalculateAlarm()` includes `reconciliation.computeReconciliationAlarmTime()` in the alarm candidate set.
  - `scheduleHeartbeatAlarm()` only considers heartbeat, idle cleanup, attention, and mailbox alarm times.
  - `updateNodeHeartbeats()` calls `scheduleHeartbeatAlarm()` whenever node-level ACP heartbeats update active sessions.
- `apps/api/src/durable-objects/project-data/reconciliation.ts`
  - Candidate detection requires task-mode sessions with `task_mode='task'` and status `in_progress` or `delegated`.
  - The production task met those D1 criteria.
- `apps/api/tests/unit/durable-objects/reconciliation.test.ts`
  - Current tests cover candidate selection and check-in behavior but do not cover heartbeat-driven alarm recomputation.
- `docs/notes/2026-04-22-chat-idle-cleanup-message-activity-postmortem.md`
  - Relevant lesson: lifecycle timers must be refreshed and computed from authoritative server-side activity, not divergent client/fast-path behavior.
- `tasks/archive/2026-05-13-task-reconciliation-checkin.md`
  - Original implementation explicitly intended ProjectData alarms to multiplex reconciliation with idle cleanup, heartbeat, attention expiry, and mailbox delivery.

## Implementation Checklist

- [x] Add a regression test proving the heartbeat alarm fast path includes the reconciliation deadline for idle task-mode sessions.
- [x] Add a regression test proving heartbeat alarm scheduling still includes workspace idle checks, matching full alarm recomputation.
- [x] Refactor ProjectData alarm candidate calculation so `recalculateAlarm()` and heartbeat-triggered scheduling cannot diverge again.
- [x] Run focused ProjectData/reconciliation tests.
- [x] Run API lint/typecheck/test validation for the touched package.
- [x] Document the root cause and verification notes for the PR body.

## Acceptance Criteria

- [x] A healthy node heartbeat cannot push the ProjectData alarm later than an eligible task-mode reconciliation check-in.
- [x] Heartbeat-triggered alarm scheduling considers the same lifecycle alarm candidates as full recomputation.
- [x] Existing heartbeat timeout behavior remains covered.
- [x] Focused tests pass locally.
- [x] Full relevant API checks pass before PR.

## Verification Notes

- Root cause: `updateNodeHeartbeats()` refreshed ProjectData alarms through `scheduleHeartbeatAlarm()`, but that fast path used a smaller candidate set than `recalculateAlarm()` and omitted task-mode reconciliation and workspace idle checks.
- Fix: ProjectData alarm scheduling now uses a shared `computeProjectDataAlarmTime()` candidate calculation for full recomputation and heartbeat-triggered scheduling.
- Regression coverage:
  - `computeProjectDataAlarmTime` keeps a due reconciliation deadline ahead of the healthy heartbeat timeout.
  - `computeProjectDataAlarmTime` keeps a workspace idle check ahead of the healthy heartbeat timeout.
- Validation passed:
  - `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/reconciliation.test.ts`
  - `pnpm --filter @simple-agent-manager/api lint`
  - `pnpm --filter @simple-agent-manager/api typecheck`
  - `pnpm --filter @simple-agent-manager/api test`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`

## References

- Production task: `01KRNE7Y5FR3J5JAXZ1J0FX063`
- Backlog idea: `01KRNK5T2Z77EAMM3WKQMP4M50`
- `apps/api/src/durable-objects/project-data/index.ts`
- `apps/api/src/durable-objects/project-data/reconciliation.ts`
- `apps/api/tests/unit/durable-objects/reconciliation.test.ts`
