# Fix reconciliation check-in false deaths and attention-expiry terminal writer

**Status**: completed
**Created**: 2026-08-26
**SAM task**: `01M0XRNZWZVQACVKPGG1BJ75FW`
**Branch**: `sam/stop-reconciliation-check-false-bj75fw`
**Audit source**: SAM library `/reliability/audits/production-stability-audit-2026-08-25.md`

## Problem

The 2026-08-25 production stability audit reproduced a healthy Codex task being failed as
`Agent became unresponsive after SAM check-in` about 67 seconds after the check-in prompt began.
The ProjectData object had already recorded local ACP/runtime activity proving the current prompt
generation was working, but the `reconciliation_checkin` marker was only resolved by a persisted
assistant message. A long silent tool turn can therefore lose to the 60-second marker expiry.

The same expiry path writes a bare D1 task failure in
`apps/api/src/durable-objects/project-data/attention-expiry.ts`: no `task_status_events` row,
no `completed_at`, and stale `execution_step`. This is the deferred follow-up from
`tasks/backlog/2026-08-06-attention-expiry-task-status-events.md` plus the stronger audit finding.

## Research findings

- `reconciliation.ts` creates `reconciliation_checkin` markers with
  `DEFAULT_TASK_RECONCILIATION_RESPONSE_DEADLINE_MS` (60 seconds) after persisting the check-in
  user message and sending the prompt off the alarm critical path.
- `message-persistence.ts` resolves `reconciliation_checkin` only when an assistant message is
  persisted. Prompt acceptance, `session_state.activity='prompting'`, harness
  `runtime_work_state`, and node heartbeats do not resolve or extend the marker.
- `session_state` is local ProjectData SQLite. It records ACP working state (`prompting` /
  `recovering`) and harness work state (`active` / `settling`) with progress timestamps.
  The expiry alarm can read that state without a remote VM/node call.
- Reconciliation candidate selection already avoids sending new check-ins while a prompt is in
  flight below configured stall thresholds, but this does not protect the marker after the check-in
  is accepted and the agent remains silently busy.
- `attention-expiry.ts:failTaskAndWorkspace` directly updates D1 tasks and stops the workspace.
  It bypasses status-event, `completed_at`, `execution_step=NULL`, trigger-execution sync, task-wait
  terminal hooks, and supersession/optimistic fences.
- `idle-cleanup-terminalization.ts` and `scheduled/stuck-tasks.ts` show the current guarded
  terminal-write pattern: active-status CAS, status event written for the winning transition,
  `completed_at`, `execution_step=NULL`, trigger sync, and a write-time live-supersession guard.
- `task-terminal-cleanup.ts` handles runtime/session cleanup after a terminal state, not the
  task-row transition itself.
- Relevant retained lessons: `.claude/rules/57`, `.claude/rules/58`, `.claude/rules/59`,
  `.claude/rules/62`, `.claude/rules/66`, and the archived reconciliation prompt-in-flight and
  idle-cleanup terminalization tasks.

## Implementation checklist

- [x] Add a local ProjectData expiry guard for expired `reconciliation_checkin` markers:
      if the latest active ACP session for the marker's chat/workspace has current-generation
      `prompting`/`recovering` activity or `runtime_work_state IN ('active','settling')` with
      evidence at or after marker creation, extend the marker by the reconciliation deadline.
- [x] Record a diagnostic activity event when a reconciliation check-in expiry is deferred by
      current-generation ACP/runtime work.
- [x] Preserve genuine no-delivery/no-liveness expiry: no fresh ACP activity/runtime-work evidence
      still resolves the marker as expired and fails the task.
- [x] Route attention-expiry task terminalization through a shared guarded D1 transition helper
      rather than a bare task update.
- [x] Ensure the helper writes `task_status_events`, sets `completed_at`, clears `execution_step`,
      syncs trigger executions, runs task terminal hooks, is idempotent, and has a write-time
      live-supersession fence.
- [x] Keep workspace/task-run cleanup and ProjectData session failure behavior intact, including
      summary sync through the existing `failSession` path.
- [x] Add discriminating tests:
  - [x] check-in delivered, current-generation ACP prompting/runtime work stays active for more
        than 60 seconds with no assistant token; marker renews and task survives;
  - [x] genuine no-delivery/no-liveness expiry still terminates;
  - [x] terminal write emits the status event, timestamps, cleared execution step, trigger sync /
        hooks as applicable, and remains idempotent.
- [x] Archive or otherwise resolve the older narrow backlog item for attention-expiry status
      events when this broader fix lands.

## Validation evidence

- `pnpm --filter @simple-agent-manager/api test -- attention-expiry task-terminal-transition`
  passed: 3 files / 12 tests.
- `pnpm --filter @simple-agent-manager/api test -- reconciliation` passed: 6 files / 164 tests.
- `pnpm typecheck && pnpm lint` passed. Lint retained only baseline warnings in acp-client and web.
- `pnpm --filter @simple-agent-manager/api test` passed: 606 files / 8254 tests.
- `pnpm format:check` passed.
- `git diff --check` passed.
- `Deploy Staging` passed for commit `b940ed42b`:
  https://github.com/raphaeltm/simple-agent-manager/actions/runs/32919441324.
- Live staging Playwright smoke passed 12/12 against `app.sammy.party` / `api.sammy.party`
  using staging token-login auth.
- PR #1916 CI passed before merge.

## Acceptance criteria

- An active current-generation ACP prompt or harness work report can defer/renew an expired
  `reconciliation_checkin` marker without requiring a persisted assistant message.
- Node heartbeat alone does not defer a check-in expiry.
- Expired check-ins with no delivery/liveness evidence still fail the task and clean up the runtime.
- Attention-expiry D1 task failures follow the shared terminal transition contract: single winning
  transition, status event, `completed_at`, `execution_step=NULL`, trigger-execution sync, task-wait
  terminal hook, workspace cleanup, ProjectData session failure/summary sync, and supersession
  protection.
- Tests use production-shaped paths and fail against the pre-fix behavior for the false-death case.
- Quality gates, specialist review, staging verification, PR merge, and production deploy monitoring
  complete successfully.

## References

- `apps/api/src/durable-objects/project-data/attention-expiry.ts`
- `apps/api/src/durable-objects/project-data/reconciliation.ts`
- `apps/api/src/durable-objects/project-data/message-persistence.ts`
- `apps/api/src/durable-objects/project-data/session-state.ts`
- `apps/api/src/durable-objects/project-data/idle-cleanup-terminalization.ts`
- `apps/api/src/scheduled/stuck-tasks.ts`
- `tasks/archive/2026-06-20-reconciliation-prompt-in-flight.md`
- `tasks/archive/2026-08-06-fix-idle-sweep-silent-task-completion.md`
- `tasks/archive/2026-08-06-attention-expiry-task-status-events.md`
