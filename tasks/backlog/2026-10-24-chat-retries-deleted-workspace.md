# Chat retries a deleted workspace and logs 404s

## Problem

Opening a chat whose workspace has been deleted (for example a day-old stopped session) makes the chat request `GET /api/workspaces/:id` repeatedly. Every request returns 404 and the browser logs "Failed to load resource: the server responded with a status of 404". The retries come from `useSessionInfrastructure` → `useRetryingInfrastructureResource(workspaceId, workspace?.id, getWorkspace, setWorkspace)` (`apps/web/src/components/project-message-view/useSessionInfrastructure.ts`), which treats a 404 like a transient failure.

## Context

Found on staging on 2026-10-24 at 02:18Z, during the comment reader's live check (branch `sam/comment-context-reader`). The check opened a chat in the Potato project (session `160d9aed-b74d-4956-8d2a-1f2fb00a2167`, workspace `01M5K1VJ1G490QGPYTV9APDB8W`). That made 4 failing requests on desktop and 2 on a phone. That branch does not touch this hook or the workspaces client.

## Acceptance Criteria

- [ ] A 404 for the session's workspace is treated as "the workspace is gone" and not retried.
- [ ] Opening such a chat makes at most one workspace request, and the chat shows its existing stopped/archived state without console errors from retries.
- [ ] A test drives the hook with a 404 response and asserts one request and the "gone" state. A paired test asserts a transient 5xx is still retried.
