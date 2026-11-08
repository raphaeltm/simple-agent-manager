# A chat stopped by its owner shows "Failed — could not classify"

## Problem

On staging, the owner stopped a live VM conversation chat with `POST /api/projects/:projectId/sessions/:sessionId/stop`.
The response was `200 {"status":"stopped","workspaceDeleted":true}`. Afterwards the chat header showed
**Stopped** and the chat body showed a red **Failed** (Retryable) banner: "The task failed for a reason
SAM could not automatically classify."

A deliberate user stop is a normal lifecycle end, not a failure (policies: "Parent-stopped tasks are
cancelled, not failed"; "Do not diagnose normal lifecycle terminations").

## Context

- Found 2026-11-05 while verifying PR #2541 (comment-core unification); unrelated to that change.
- Staging project `01KJNR9R3TEN3KX1ETE33852R8`, chat `42a13a98-eb05-4e4b-9741-eb712f5dcaed`,
  task `01M6NJPCWZB3SC8ZDS3XXCRE3Z` (conversation mode, VM, lightweight). It was stopped at about 11:58 UTC
  while idle, after two comment directives had been delivered and answered.
- Screenshot: `/engineering/comment-core-unification/staging/` in the SAM Library (`events-panel-after.png`
  shows the banner).

## Acceptance Criteria

- [ ] Trace which writer sets the task to `failed` after an owner `POST …/stop` on an idle conversation
- [ ] An owner stop of a conversation ends as stopped/cancelled, with no "Failed" banner and no diagnosis
- [ ] A regression test drives the real stop route and asserts the task's terminal status
