# Chat page requests a deleted workspace three times (404) for stopped sessions

## Problem

Opening a stopped chat session whose workspace has been deleted makes the web app call
`GET /api/workspaces/:workspaceId` three times. Each call returns 404 and logs a browser console error
("Failed to load resource: the server responded with a status of 404"). The transcript renders
correctly, so the requests are wasted round trips and console noise. The three identical calls look
like a query retry on a permanent 404.

## Context

Found on 2026-11-13 during staging verification of PR #2702 (archive drain). It reproduces on an
archived session (`01KWHD8XS7MQ7R6KWXJYRHDVH4` / `4745a38a-…`, workspace `01M6PTMH0R6AY7BFC13HSF7MMA`).
It also reproduces on a session still on the root object (`01KJNR9R3TEN3KX1ETE33852R8` / `b82b360a-…`,
workspace `01M2EYHVKGDJ0QZGF3G5VGM7ZK`), so the archive path is not the cause.

## Acceptance Criteria

- [ ] Find the hook or query on the chat page that fetches the session's workspace, and stop it
      when the session is stopped and the workspace is known to be deleted, or treat 404 as a
      terminal "workspace gone" state.
- [ ] A 404 for a workspace is not retried (TanStack Query `retry` must exclude 4xx).
- [ ] Opening a stopped session with a deleted workspace produces no 404 console errors.
- [ ] Behavioral test covering the deleted-workspace case.
