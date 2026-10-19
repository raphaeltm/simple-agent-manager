# Chat page retries a workspace fetch that 404s for a stopped Instant chat

## Problem

Opening a stopped (or slept, torn-down) Instant chat as its owner makes the chat page request
`GET /api/workspaces/:id` for the chat's workspace, which no longer exists, so it answers 404.
`useSessionInfrastructure` (`apps/web/src/components/project-message-view/useSessionInfrastructure.ts`)
treats every failure as transient and retries on `VITE_SESSION_INFRA_RETRY_DELAYS_MS`
(2 s, 5 s, 10 s by default): four failed requests and four console errors per open.

## Context

Seen on staging 2026-10-19 while checking console errors for the shared-sessions PR (idea
`01M59MYE4GY91BWTE8TZF1ZB5D`): the owner's page on a stopped Instant chat logged three 404s for
its workspace. That PR stops non-owners from requesting the owner's workspace at all
(`ownedWorkspaceId`), so this remains only for owners of chats whose workspace is gone.

## Acceptance Criteria

- [ ] A 404 for the session's workspace is not retried, and the page does not request it again
      for that workspace id.
- [ ] Transient failures (network, 5xx) still retry as today.
- [ ] Tests cover both: one request on 404; retries on a 503.
