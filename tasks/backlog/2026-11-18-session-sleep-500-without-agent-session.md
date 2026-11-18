# Session sleep returns 500 when the workspace has no resumable agent session

## Problem

`POST /api/projects/:projectId/sessions/:sessionId/sleep` returns `500 INTERNAL_ERROR` with the
logged error "Workspace has no resumable agent session" when the agent never started (for example
its credential was missing). This is a designed refusal, not a server fault, and should answer a
4xx (likely `409`) that the UI can explain.

## Context

Found 2026-11-18 on staging2 while verifying PR #2889 (L20), request
`9c8af072-ce5d-4331-abb0-9d9aa0e1eb82`: the bootstrap admin's `opencode` agent had no credential,
so no agent session existed. Unrelated to L20 (the route and `sleepWorkspaceSession()` are
unchanged). Once a claude-code agent session existed, the same route returned 200 and the snapshot
was captured.

## Acceptance Criteria

- [ ] `sleepWorkspaceSession()` (`apps/api/src/services/session-sleep.ts`) maps "no resumable
      agent session" to a documented 4xx through the chat sleep route
- [ ] A route test drives a workspace with no agent session and asserts the status and message
