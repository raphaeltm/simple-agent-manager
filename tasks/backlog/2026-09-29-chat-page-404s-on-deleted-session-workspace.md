# Chat page requests a deleted workspace and logs 404s

## Problem

Opening an ended chat session whose workspace has been deleted makes the web app call
`GET /api/workspaces/:id` for that workspace two or three times. Each call returns 404 and
the browser console logs `Failed to load resource: the server responded with a status of 404`.

## Context

Found on staging (2026-09-29) while verifying the whole-session resource timeline:
project `01KWHD8XS7MQ7R6KWXJYRHDVH4`, session `cbb7fed4-33ac-469a-bc68-c9ebc5d3164f`,
workspace `01M3KTM46PGYA025F6CT7J0HHP`. The 404s happen on page load without opening any
drawer, so they are unrelated to the Resources drawer.

## Acceptance Criteria

- [ ] Identify which chat-page hook/component requests the session's workspace
- [ ] Ended sessions with a deleted workspace do not request it (or treat 404 as a known terminal state without console noise)
- [ ] Regression test with a deleted-workspace session fixture
