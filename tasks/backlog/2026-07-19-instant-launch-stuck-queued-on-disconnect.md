# Instant-Session Launch Leaves Task Stuck `queued` When the Client Disconnects

> **Reconciliation 2026-10-05:** The "confirm cleanup of the two July tasks" sub-item can be dropped: production D1 shows both tasks `failed` by the stuck-queued sweep at 2026-07-19T01:20Z, with their workspaces and nodes `deleted`. Everything else is unchanged; still no test drives the `instant_persistence` branch (`apps/api/src/scheduled/stuck-tasks.ts:906,1277`).

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - The launch survives a disconnect: `POST .../sessions/start` persists the task first,
>     returns 202 and continues under `waitUntil` (`apps/api/src/routes/chat-start.ts:39-49,240`;
>     PR #1722, f8a284cca).
>   - Stale sweep: a task stuck in `instant_persistence` past `INSTANT_START_STALE_TIMEOUT_MS`
>     (default 10 min) is failed with a diagnosable message
>     (`apps/api/src/scheduled/stuck-tasks.ts:40,1265-1270`; PR #1722).
> - **Still open:**
>   - Regression test: nothing in `apps/api/tests` drives the `instant_persistence` sweep branch
>     or a mid-launch cancellation.
>   - Confirm (or drop) the cleanup of the two July production tasks; the generic
>     `TASK_STUCK_QUEUED_TIMEOUT_MS` sweep should already have failed them.
>   - `apps/api/src/services/instant-session.ts:478-481` also points here for the missing
>     TaskRunner execution-timeout watchdog on task-mode Instant sessions.

## Problem

`launchInstantSession` runs entirely inside the `POST /api/projects/:projectId/sessions/start` request context (`apps/api/src/routes/chat-start.ts` → `apps/api/src/services/instant-session.ts:launchInstantSession`). When the browser disconnects mid-launch (mobile app backgrounded, user gives up, network blip), the Worker invocation is cancelled and the `catch` block that marks the task `failed` / workspace `error` / chat session failed never runs.

Observed in production during the 2026-07-19 instant-container incident: tasks `01KXVX7W6BVFHQDQSR0S93TE89` and `01KXVWWDRJ6M8GW6X9HFX3YPPH` ("Hello?", 2026-07-19 00:37/00:43 UTC) are stuck `queued` with `status='creating'` workspaces and 1-message sessions, with no error recorded anywhere — while sibling failures that stayed connected were correctly marked `failed` with `Request timed out after 30000ms`.

## Context

- Discovered while diagnosing `tasks/archive/2026-07-19-fix-instant-container-clone-timeout.md` (the clone-timeout fix dramatically shrinks the MEDIAN launch window, but raises the create-phase CEILING from 30s to 120s — so the worst-case disconnect-exposure window is wider, not narrower; prioritize accordingly).
- The stuck rows also strand the node record in `creating`/`launching` and are only visible as "queued forever" in the UI.

## Acceptance Criteria

- [ ] Instant-session launch survives client disconnect: either run the launch under `ctx.waitUntil`/a Durable Object so it completes (and the UI catches up via polling), or guarantee failure-marking runs on cancellation.
- [ ] A sweep/cron guard marks instant tasks stuck in `queued`/`instant_persistence`-era execution steps beyond a configurable deadline as `failed` with a diagnosable error message (rule 47: every candidate needs an escape path).
- [ ] Regression test: simulate request cancellation mid-launch and assert the task does not remain `queued` indefinitely.
- [ ] Clean up the two stranded production tasks/workspaces/nodes listed above (or verify the sweep does).
