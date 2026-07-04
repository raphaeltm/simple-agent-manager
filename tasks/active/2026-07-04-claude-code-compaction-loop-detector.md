# Claude Code Compaction Loop Detector MVP

## Problem

SAM-managed Claude Code sessions can enter repeated `Compacting...` / `Compacting completed` loops. These sessions continue spending tokens while making little or no useful progress and can end in usage-limit or disconnect failures. The MVP should detect the loop from recent message evidence and stop/fail the affected task visibly with diagnostic context. It must not auto-fork or resume sessions in this phase.

## Research Findings

- `apps/api/src/scheduled/stuck-tasks.ts` is the right detector-first insertion point. It already runs from cron, enumerates active tasks, gathers diagnostics, persists observability events, writes `task_status_events`, syncs trigger execution status, and calls `cleanupTaskRun`.
- Existing stuck recovery is timeout-based. The new detector must run independently of elapsed-time thresholds and only trip on recent message evidence.
- ProjectData access patterns:
  - `apps/api/src/services/project-data.ts#getMessages` can read recent messages from the per-project `ProjectData` Durable Object with role filters and `order`.
  - `apps/api/src/durable-objects/sam-session/tools/get-session-messages.ts` uses `getMessages` and groups tokens for user-facing tools.
  - `apps/api/src/durable-objects/sam-session/tools/search-task-messages.ts` resolves a session from a task via `listSessions`.
- Session linkage:
  - Task sessions are represented by `chat_sessions.task_id` in ProjectData and also commonly by `workspaces.chat_session_id` in D1.
  - `projectDataService.listSessions(env, projectId, null, 1, 0, taskId)` is the established task-to-session lookup when only task ID is known.
- Cancellation/status patterns:
  - `apps/api/src/durable-objects/sam-session/tools/stop-subtask.ts` stops the latest running `agent_sessions` row on the workspace via `stopAgentSessionOnNode`, marks the task `cancelled`, and stops the chat session.
  - `apps/api/src/scheduled/stuck-tasks.ts` marks system-detected failures as `failed`, records a system `task_status_events` row, persists observability evidence, syncs trigger execution, and invokes `cleanupTaskRun`.
  - For this detector, `failed` is preferable to user `cancelled` because this is a system-detected reliability failure.
- `apps/api/src/services/node-agent.ts#stopAgentSessionOnNode` performs the VM agent stop call. `cleanupTaskRun` is already the stuck-task path for best-effort workspace/node cleanup after a visible failure.
- Tests exist for this area:
  - `apps/api/tests/unit/stuck-tasks.test.ts` mocks D1 and verifies recovery decisions.
  - `apps/api/tests/workers/scheduled-stuck-tasks.test.ts` provides Miniflare vertical-slice tests for status events and observability.
- The referenced report `/engineering/research/claude-code-compaction-loop-report-2026-07-04.md` was not present in this container or repository when checked with `find`.

## Implementation Checklist

- [ ] Add configurable compaction-loop thresholds to the API env shape and defaults local to the detector:
  - enable flag: `CLAUDE_CODE_COMPACTION_LOOP_DETECTOR_ENABLED`
  - recent message limit/window: `CLAUDE_CODE_COMPACTION_LOOP_RECENT_MESSAGE_LIMIT`
  - minimum marker pairs: `CLAUDE_CODE_COMPACTION_LOOP_MIN_PAIRS`
  - maximum messages between markers if needed: `CLAUDE_CODE_COMPACTION_LOOP_WINDOW_MESSAGES`
- [ ] Add pure detector logic in `apps/api/src/scheduled/stuck-tasks.ts` or a small sibling module so tests can cover marker matching without D1/DO setup.
- [ ] In `recoverStuckTasks`, for active `in_progress` Claude Code tasks, resolve the task session and inspect recent text messages via ProjectData.
- [ ] Detect repeated `Compacting...` / `Compacting completed` marker evidence in a rolling recent-message window.
- [ ] On detection, fail the task visibly with a diagnostic reason, observability context containing marker counts/snippets/session ID, a system `task_status_events` row, trigger execution sync, and cleanup.
- [ ] Avoid duplicate spending by stopping/cleaning up via the existing stuck-task recovery path; do not auto-fork/retry/resume.
- [ ] Add focused unit tests for detector logic and recovery behavior.
- [ ] Add or update env documentation only where repo conventions require operational env examples.
- [ ] Run focused tests and the required quality checks.
- [ ] Run specialist validation: task completion, Cloudflare/API, env/config, constitution, and test review.
- [ ] Open a PR on `sam/implement-first-sam-compaction-01kwpw`.

## Acceptance Criteria

- Active Claude Code task sessions with repeated recent compaction markers are failed/stopped by the scheduled job before normal elapsed-time stuck thresholds.
- Long-running tasks without matching compaction-loop message evidence are not stopped by the detector.
- Thresholds are configurable through environment variables with safe defaults.
- Failure is visible in task status, task error message, status events, logs, and observability diagnostics.
- Evidence persisted for debugging includes task ID, project ID, session ID if resolved, marker counts, configured thresholds, and bounded recent snippets.
- No auto-fork/resume behavior is implemented.
- Tests cover both positive detection and negative/non-Claude/non-loop cases.

## References

- `apps/api/src/scheduled/stuck-tasks.ts`
- `apps/api/src/services/project-data.ts`
- `apps/api/src/durable-objects/sam-session/tools/get-session-messages.ts`
- `apps/api/src/durable-objects/sam-session/tools/search-task-messages.ts`
- `apps/api/src/durable-objects/sam-session/tools/stop-subtask.ts`
- `apps/api/src/services/node-agent.ts`
