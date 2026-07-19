# Instant-Session Launch Leaves Task Stuck `queued` When the Client Disconnects

## Problem

`launchInstantSession` runs entirely inside the `POST /api/projects/:projectId/sessions/start` request context (`apps/api/src/routes/chat-start.ts` → `apps/api/src/services/instant-session.ts:launchInstantSession`). When the browser disconnects mid-launch (mobile app backgrounded, user gives up, network blip), the Worker invocation is cancelled and the `catch` block that marks the task `failed` / workspace `error` / chat session failed never runs.

Observed in production during the 2026-07-19 instant-container incident: tasks `01KXVX7W6BVFHQDQSR0S93TE89` and `01KXVWWDRJ6M8GW6X9HFX3YPPH` ("Hello?", 2026-07-19 00:37/00:43 UTC) are stuck `queued` with `status='creating'` workspaces and 1-message sessions, with no error recorded anywhere — while sibling failures that stayed connected were correctly marked `failed` with `Request timed out after 30000ms`.

## Context

- Discovered while diagnosing `tasks/archive/2026-07-19-fix-instant-container-clone-timeout.md` (the clone-timeout fix dramatically shrinks the launch window and therefore the exposure, but does not eliminate the class).
- The stuck rows also strand the node record in `creating`/`launching` and are only visible as "queued forever" in the UI.

## Acceptance Criteria

- [ ] Instant-session launch survives client disconnect: either run the launch under `ctx.waitUntil`/a Durable Object so it completes (and the UI catches up via polling), or guarantee failure-marking runs on cancellation.
- [ ] A sweep/cron guard marks instant tasks stuck in `queued`/`instant_persistence`-era execution steps beyond a configurable deadline as `failed` with a diagnosable error message (rule 47: every candidate needs an escape path).
- [ ] Regression test: simulate request cancellation mid-launch and assert the task does not remain `queued` indefinitely.
- [ ] Clean up the two stranded production tasks/workspaces/nodes listed above (or verify the sweep does).
