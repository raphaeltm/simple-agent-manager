# Slept chat sessions log repeated 404s fetching their retired workspace

## Problem

Opening a project chat whose session is sleeping logs several browser console errors
(`Failed to load resource: 404`) for `GET /api/workspaces/<id>`. The workspace row is retired
when the session sleeps, but `useSessionInfrastructure`
(`apps/web/src/components/project-message-view/useSessionInfrastructure.ts`,
`useRetryingInfrastructureResource`) still fetches the session's `workspaceId` and retries it on
the `[2s, 5s, 10s]` schedule, so each load of a slept chat produces about four 404s. Nothing
visible breaks, but the errors are noise for console-error checks in staging verification.

## Context

Seen on staging on 2026-11-12 while verifying the Codex secret-card fix (task
`01M7823R2H8NBNAVAR4BFSWFV2`): sessions `ff0d98a2-a98c-4106-bb3f-f248321de941` and
`c600096d-f10f-4a99-a9cd-e6c72d5bbeb9` after idle sleep. The same pages had zero console errors
while their sessions were awake.

## Acceptance Criteria

- [ ] A sleeping (or stopped) session does not fetch, or does not retry, a workspace it knows is
      retired; a 404 for the session's workspace is treated as terminal for that id
- [ ] Opening a slept chat on staging produces no 404 console errors
- [ ] A test drives the hook with a slept session and asserts no retry after a 404
