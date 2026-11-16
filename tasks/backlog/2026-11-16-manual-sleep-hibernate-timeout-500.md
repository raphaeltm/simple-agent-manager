# Manual chat sleep returns 500 when the VM agent's hibernate call exceeds 5 s

## Problem

`POST /api/projects/:projectId/sessions/:sessionId/sleep` returned `500 INTERNAL_ERROR` on staging2
(2026-11-16T09:45:59Z, request `42e1b0f7-9cf7-4ed4-8c15-afe85eb40824`). The platform error log shows
`Request timed out after 5000ms: https://<node>.vm.sammy2.party:8443/workspaces/<ws>/agent-sessions/<id>/hibernate`.
A second attempt ~80 s later succeeded and the chat slept with a snapshot.

A VM agent that is slow to acknowledge hibernate is an expected, retryable condition, not a server fault.
The route maps it to an opaque 500 and the person gets no indication that retrying will work.

## Context

Found while verifying inbox slice G (PR #2780) on staging2: sleeping a freshly started VM chat right
after its agent's first turn. The chat had just finished a prompt (`ACP Prompt completed` at 09:45:50Z).

## Acceptance Criteria

- [ ] A hibernate timeout returns a designed, retryable status (for example 503 or 409 with a clear message), not 500
- [ ] The timeout budget for the hibernate call is checked against how long snapshot capture actually takes, and is configurable (`DEFAULT_*` constant)
- [ ] A route test drives the real handler with a VM agent that answers after the budget and asserts the designed status
