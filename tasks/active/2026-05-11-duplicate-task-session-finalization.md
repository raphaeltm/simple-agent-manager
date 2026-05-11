# Fix Duplicate Task Sessions And Finalization Drift

## Problem

Production incident on 2026-05-11 showed one canonical D1 task (`01KRB7ZM0N4WGQRE52QM7D8JHV`) with multiple ProjectData chat sessions linked to the same task. The legitimate session had a workspace and normal message history; five orphan sessions had the same task ID/title, `workspaceId = null`, one message, and stayed active.

The likely root cause is scheduler ordering: `ProjectOrchestrator` creates a ProjectData chat session before it atomically claims the D1 task for dispatch. Repeated scheduling cycles can therefore create orphan sessions while `TaskRunner` duplicate starts are no-ops because the DO is keyed by task ID.

There is a broader lifecycle problem: terminal task events are split across D1, ProjectData, TaskRunner, VM callbacks, NodeLifecycle, idle cleanup, and scheduled sweeps. User-visible chat/workspace state can remain active until delayed repair paths run. Sweeps should be safety repair, not the normal terminal fan-out path.

## Research Findings

- Idea `01KRBP9186JETX0F7TGBQC6PKE` defines acceptance criteria for duplicate scheduler ticks, TaskRunner idempotent duplicate starts, terminal finalization, and orphan-session repair/prevention.
- ADR 004 confirms the storage boundary: D1 owns task/workspace metadata while per-project ProjectData DO owns chat sessions, messages, activity, and real-time streams.
- `docs/architecture/workspace-lifecycle.md` documents chat-session creation and cleanup flows and highlights places where workspace and chat state can drift.
- Relevant prior incidents to apply:
  - `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`: preserve canonical ProjectData identity boundaries; do not infer session identity from unrelated D1 rows.
  - `docs/notes/2026-04-22-chat-idle-cleanup-message-activity-postmortem.md`: cleanup based on stale or wrong activity signals leaves chat state active too long.
  - `docs/notes/2026-03-04-chat-session-cross-contamination-postmortem.md` and `docs/notes/2026-03-07-chat-session-leakage-postmortem.md`: chat/session isolation regressions need behavioral tests, not source-contract checks.
  - `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md`: specialist reviewers must complete before advancing.
- `docs/recent-changes.md` notes that ProjectOrchestrator runs an alarm-driven scheduling loop and `complete_task` already triggers immediate scheduling; this task must preserve task-mode versus conversation-mode semantics.

## Implementation Checklist

- [ ] Inspect scheduler, TaskRunner DO startup, task callback, MCP `complete_task`, task CRUD, ProjectData sessions, and idle cleanup code paths.
- [ ] Add an atomic D1 dispatch claim before ProjectOrchestrator creates a ProjectData chat session.
- [ ] Ensure failed TaskRunner startup clears the claim or terminally fails the task and stops the created session.
- [ ] Preserve explicit task-mode versus conversation-mode behavior.
- [ ] Add a single task finalization service/path for terminal task fan-out where practical.
- [ ] Wire `complete_task`, task callback terminal transitions, TaskRunner failure/cancel paths, and relevant repair paths through finalization.
- [ ] Add repair/prevention for orphan active ProjectData sessions linked to a terminal or duplicate task session.
- [ ] Add focused behavioral tests for repeated scheduler cycles and duplicate TaskRunner starts.
- [ ] Add focused behavioral tests for `complete_task` finalization and callback finalization.
- [ ] Add focused behavioral tests for orphan-session repair/prevention and task-mode/conversation-mode semantics.
- [ ] Add required bug postmortem and process fix for this class of lifecycle ordering bug.
- [ ] Run local quality checks and impacted tests.
- [ ] Run specialist validation (`task-completion-validator`, `cloudflare-specialist`, `constitution-validator`, `test-engineer`, and security review if touched paths warrant it).
- [ ] Deploy to staging and verify the changed backend behavior without relying on cleanup sweeps.
- [ ] Push the branch and open a PR; do not merge unless explicitly asked.

## Acceptance Criteria

- Repeated ProjectOrchestrator scheduling cycles cannot create multiple chat sessions for the same D1 task.
- A completed, failed, or cancelled task has no lingering active ProjectData chat session unless explicitly in conversation/follow-up mode.
- UI session/workspace status changes promptly after terminal task events, without waiting many minutes for cleanup sweeps.
- Tests cover duplicate scheduler ticks, TaskRunner idempotent duplicate starts, `complete_task` finalization, callback finalization, and orphan-session repair behavior.
- Existing task-mode versus conversation-mode semantics remain explicit and tested.

## References

- SAM idea `01KRBP9186JETX0F7TGBQC6PKE`
- `apps/api/src/durable-objects/project-orchestrator/scheduling.ts`
- `apps/api/src/services/task-runner-do.ts`
- `apps/api/src/durable-objects/task-runner/index.ts`
- `apps/api/src/routes/mcp/task-tools.ts`
- `apps/api/src/routes/tasks/crud.ts`
- `apps/api/src/services/task-runner.ts`
- `apps/api/src/durable-objects/project-data/sessions.ts`
- `apps/api/src/durable-objects/project-data/idle-cleanup.ts`
- `apps/api/src/routes/chat.ts`
- `docs/adr/004-hybrid-d1-do-storage.md`
- `docs/architecture/workspace-lifecycle.md`
