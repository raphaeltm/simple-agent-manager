# Sleeping Instant workspaces get queued for runtime deletion and can no longer wake

## Problem

On staging, sleeping `cf-container` (Instant) workspaces are put through the NodeLifecycle
workspace-deletion queue. After repeated failed attempts the workspace row moves to `stopping`
with `error_message = 'Workspace deletion unconfirmed: VM attempt N (Error: request_failed)'`,
while its node stays `sleeping` and its snapshot stays `sleeping`. Waking the chat then fails:
`recovery_error = 'The sleeping container runtime is gone and cannot wake in place. Sleeping
container workspace is stopping'` (`vm-prompt-delivery-target.ts`), and the wake request hangs.

Evidence (staging D1, 2026-11-03):

- `01M6HCCD63N8586E3P4679EBRX` (chat `71a3d502-9f20-4388-aa8b-92c7c750c7be`): slept 19:09, moved
  to `stopping` 21:25 (attempt 8). A later wake from the UI never completed.
- `01M6GXNAE8AWVYJ7X2YRB81QX8`, `01M6GY9E3K25YRRG0X0KC5KFB3` (another session): `stopping` at
  21:05 (attempt 12).
- The same signature earlier the same day at 02:xx (3) and 03:xx (1), while staging ran
  `sam/repair-orphan-workspace-cleanup` (PR #2497, since merged to main).
- Production (read-only check, 22:05Z): no `cf-container` workspace carries this diagnostic, and
  none is `stopping` behind a `sleeping` snapshot.

`scheduleSleepingWorkspaceDeletion` (`session-sleep-teardown.ts`) returns early for
`cf-container`, so something else enqueues these. Candidates: `workspace-cleanup.ts` and the
stale-workspace safety net in `scheduled/node-cleanup/workspace-phases.ts`.

## Context

Found while staging-verifying `sam/required-sleep-must-not-fail` (PR #2505). That branch does
not touch the deletion path; the earliest occurrences predate its first staging deploy.

## Acceptance Criteria

- [ ] Identify which writer enqueues deletion for a sleeping Instant workspace
- [ ] A sleeping Instant workspace is never queued for runtime deletion while its chat is wakeable
- [ ] A workspace already moved to `stopping` this way can still wake (or is repaired)
- [ ] Regression test through the real enqueue path, with a sleeping-Instant fixture
