# Close conversation workspace cleanup

## Problem

The small Archive button in project chat closes a conversation task through `POST /api/projects/:projectId/tasks/:taskId/close`, but that backend path only marks the task completed and stops the ProjectData session. It does not immediately clean up the linked workspace, so the workspace can remain reachable until delayed cron cleanup runs.

Production evidence showed conversation task `01KWVE9X33WGAXP0VFGX1N5WYW` completed at `2026-07-06T12:29:11.252Z`, while linked workspace `01KWVEF8JSYXR2MRAPPMESPB4M` was only stopped by cron at `2026-07-06T12:30:26.835Z`. A related cron gap skips terminal task workspaces in `recovery`, even though node active counts treat `recovery` as active.

## Research Findings

- Small Archive UI calls `closeConversationTask()` in `apps/web/src/lib/api/tasks.ts`, which posts to `/api/projects/:projectId/tasks/:taskId/close`.
- Close route is in `apps/api/src/routes/tasks/crud.ts`. It authorizes task write access, requires conversation mode, marks the task completed, records activity, and best-effort stops the ProjectData session.
- Top Complete & Delete path calls `DELETE /api/workspaces/:id`, implemented in `apps/api/src/routes/workspaces/crud.ts`. That deletes the workspace from the node best-effort, stops the session, cleans activity, stops compute tracking, deletes agent sessions, and deletes the D1 workspace row.
- Scheduled orphan cleanup in `apps/api/src/scheduled/node-cleanup.ts` selects terminal task workspaces only with `w.status = 'running'`, while active workspace counts use `running`, `creating`, and `recovery`.
- Existing scheduled cleanup worker tests live in `apps/api/tests/workers/scheduled-node-cleanup.test.ts` with realistic D1 state via Miniflare seed helpers.

## Implementation Checklist

- [x] Extract or share workspace deletion cleanup so task close can reuse the same backend semantics as `DELETE /api/workspaces/:id`.
- [x] Update `POST /tasks/:taskId/close` to immediately clean up only the closing conversation task's linked workspace after authorization and task-mode checks.
- [x] Preserve existing best-effort VM-agent/session/activity cleanup behavior while making D1 workspace removal and compute stop immediate.
- [x] Update orphan cleanup to include terminal task workspaces in `recovery` so they cannot keep nodes active indefinitely.
- [x] Add focused close endpoint regression coverage proving the linked running workspace is not left running after close and cleanup targets only that workspace.
- [x] Add focused scheduled cleanup coverage proving terminal `recovery` workspaces are reaped or demoted.
- [x] Run targeted tests and repo validation, then open and merge the PR when green.

## Acceptance Criteria

- Closing a conversation-mode task immediately removes or stops the linked workspace and does not rely on the 5-minute cron for user-visible cleanup.
- The close endpoint only affects the authorized conversation task and its linked workspace.
- Existing authorization checks remain in place.
- Terminal task workspaces in `recovery` are included in cron orphan cleanup and cannot keep a node active forever.
- Focused tests cover both the close endpoint and recovery-orphan cron regression.

## Post-Mortem

### What broke

Two user-facing completion controls had different backend semantics. The top Complete & Delete control called the workspace deletion route, while the small Archive control called a task close route that did not clean up the workspace.

### Root cause

Workspace cleanup was implemented inside the workspace route handler rather than a shared service callable by task lifecycle routes. The cron safety net also had a status mismatch: node active counts included `recovery`, but orphan cleanup only selected `running`.

### Process fix

Lifecycle bug fixes must include tests for the runtime cleanup side effect and not only task status changes. Cleanup candidate queries must keep active-status predicates aligned with the code paths that count active blockers.
