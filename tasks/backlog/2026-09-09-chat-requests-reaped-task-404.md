# Project chat requests a reaped task and logs a 404

> **Reconciliation 2026-10-12:** still open, and the request pattern changed. #2231 (`1c7f8dd90`)
> moved the restore-provisioning effect out of `useProjectChatState.ts` into
> `apps/web/src/pages/project-chat/useProvisioningTracker.ts:147-198`. It is the only page-load
> caller of `getProjectTask` for an ended chat's task (`SessionHeader.tsx:145` waits for the header
> to expand). It now keys on the selected session's `taskId` rather than the whole session list,
> which probably removes the second request seen here. But its catch block (`:178-184`) retries any
> failure, a 404 included, up to `PROVISIONING_RESTORE_RETRIES` times (default 3, `types.ts:100`)
> 2 s apart, so a reaped task can now cost up to four failed requests per open.
> `use-provisioning-tracker.test.tsx:210` pins that retry count and has no 404 case.

**Status**: backlog
**Created**: 2026-09-09
**Found**: during staging verification for PR #2052 (unrelated to that change)

## Problem

Opening a project chat session on staging fires
`GET /api/projects/01KJNR9R3TEN3KX1ETE33852R8/tasks/01M22HGVBPAC2QJ6QXEMAS9B1N`
twice, and both return **404**. The task no longer exists; the chat session still references it.

The user-visible effect is a console error and two wasted round-trips per session open. Whatever
the task reference renders (status chip, task link) presumably renders empty or stale.

## Evidence that this is pre-existing, not caused by PR #2052

`staging-tool-rail-verify.spec.ts` › `no console errors while driving the rail` fails on this.
Verified discriminating by checking out the **unmodified spec from `origin/main`** and running it
against the same staging environment: it fails identically, with the same two 404s for the same
task id. PR #2052 only swapped that file's local helpers for shared ones.

## Likely shape

Either:
- the chat session row keeps a `taskId` after the task is deleted/reaped and nothing nulls it, or
- the UI requests the task unconditionally and treats 404 as a hard error rather than "no task".

Worth checking whether this is the same lineage as the supersession/reaping work — a superseded or
reaped task leaving a dangling reference is the shape `.claude/rules/66` describes.

## Acceptance criteria

- [ ] Identify which component issues the request and why it fires twice.
- [ ] Either null the reference when the task goes away, or treat 404 as an expected empty state
      without a console error.
- [ ] `staging-tool-rail-verify.spec.ts` › `no console errors while driving the rail` passes
      against staging.
- [ ] Regression test covering a chat session whose referenced task no longer exists.
