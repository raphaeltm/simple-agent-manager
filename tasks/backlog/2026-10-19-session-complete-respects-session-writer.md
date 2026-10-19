# Session tool rail "Complete" should respect session control

## Problem

The session tool rail shows **Complete** to every viewer of a chat, and it calls
`POST /api/projects/:projectId/tasks/:taskId/status`, which allows any project member with
`task:write` to change any task's status (`apps/api/src/routes/tasks/crud.ts`). Completing a task
snapshots and sleeps its session. With shared sessions (idea `01M59MYE4GY91BWTE8TZF1ZB5D`), every
other chat control — prompt, cancel, stop, sleep, resume, answer — is limited to the session owner
and people it is shared with, so a teammate who cannot message the agent can still end its task.

## Context

Found while implementing shared sessions (branch `sam/implement-shared-sessions-comments-tan5jv`).
The task status route predates shared sessions and is also used outside chat (task lists, CLI), so
changing it needs its own review of those callers.

## Acceptance criteria

- [ ] Decide whether user-initiated task status changes for a chat-backed task require the session
      owner or a grantee (`requireSessionWriter`), and which other callers keep project-level rules
- [ ] The rail hides **Complete** for viewers who cannot use it
- [ ] Route test with a reader attack case and an owner control, proven discriminating
