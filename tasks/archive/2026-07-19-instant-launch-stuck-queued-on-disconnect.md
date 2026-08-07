# Instant-Session Launch Leaves Task Stuck `queued` When the Client Disconnects

## Problem

`launchInstantSession` runs entirely inside the `POST /api/projects/:projectId/sessions/start` request context (`apps/api/src/routes/chat-start.ts` → `apps/api/src/services/instant-session.ts:launchInstantSession`). When the browser disconnects mid-launch (mobile app backgrounded, user gives up, network blip), the Worker invocation is cancelled and the `catch` block that marks the task `failed` / workspace `error` / chat session failed never runs.

Observed in production during the 2026-07-19 instant-container incident: tasks `01KXVX7W6BVFHQDQSR0S93TE89` and `01KXVWWDRJ6M8GW6X9HFX3YPPH` ("Hello?", 2026-07-19 00:37/00:43 UTC) are stuck `queued` with `status='creating'` workspaces and 1-message sessions, with no error recorded anywhere — while sibling failures that stayed connected were correctly marked `failed` with `Request timed out after 30000ms`.

## Context

- Discovered while diagnosing `tasks/archive/2026-07-19-fix-instant-container-clone-timeout.md` (the clone-timeout fix dramatically shrinks the MEDIAN launch window, but raises the create-phase CEILING from 30s to 120s — so the worst-case disconnect-exposure window is wider, not narrower; prioritize accordingly).
- The stuck rows also strand the node record in `creating`/`launching` and are only visible as "queued forever" in the UI.

## Acceptance Criteria

- [x] Instant-session launch survives client disconnect: either run the launch under `ctx.waitUntil`/a Durable Object so it completes (and the UI catches up via polling), or guarantee failure-marking runs on cancellation.
- [x] A sweep/cron guard marks instant tasks stuck in `queued`/`instant_persistence`-era execution steps beyond a configurable deadline as `failed` with a diagnosable error message (rule 47: every candidate needs an escape path).
- [x] Regression test: simulate request cancellation mid-launch and assert the task does not remain `queued` indefinitely.
- [x] Clean up the two stranded production tasks/workspaces/nodes listed above (or verify the sweep does).

## Resolution (2026-08-07)

Completed by `tasks/archive/2026-08-07-fix-stuck-sweep-like-limit-and-durable-instant-launch.md`
after the 2026-08-07 recurrence (task `01KZECB26257JD03VFSNW0J5G6`, EffProp) proved
`ctx.waitUntil` alone is NOT durable — Cloudflare cancels it ~30s after the response even
without a client disconnect, so a 33s clone stranded the task exactly as described here.

- Durable execution: both launch paths (`chat-start.ts`, `mcp/dispatch-instant.ts`) now
  accept inline and hand the continuation to the TaskRunner DO
  (`durable-objects/task-runner/instant-launch.ts`), which runs it from an alarm with
  milestone tracking; interrupted attempts fail closed with full teardown
  (`markInstantLaunchFailed`: task failed, session failed, workspace/node error, container
  destroyed).
- Sweep guard: already existed (`INSTANT_START_STALE_TIMEOUT_MS`, default 10 min) but had
  been dead since 2026-08-06 behind the D1 LIKE 50-byte crash — fixed in the same PR, and
  sweep recovery now also fails the linked chat session.
- Regression tests: `tests/unit/durable-objects/task-runner-instant-launch.test.ts`
  (interrupted-attempt classification), `tests/workers/scheduled-stuck-tasks.test.ts`
  (instant conversation recovery vertical slice + LIKE-limit regression with seeded rows).
- Stranded-row cleanup: the revived sweep's cursor pages over ALL active tasks with no age
  bound, so the 2026-07-19 rows (if still queued) and the 2026-08-07 row are recovered by
  the first post-deploy sweeps. Verified in production after the deploy (see the 2026-08-07
  task's post-mortem).
