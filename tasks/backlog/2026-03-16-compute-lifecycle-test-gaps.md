# Compute Lifecycle Test Coverage Gaps

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - Gap 1: behavioral idle-timeout tests in
>     `apps/api/tests/unit/conversation-idle-timeout.test.ts:480-913` (stale workspace cleaned up,
>     project override wins at `:516-537`), plus the real `alarm()` in
>     `apps/api/tests/workers/project-data-workspace-idle-alarm.test.ts:21`.
>   - Gap 5: `apps/api/tests/unit/node-cleanup.test.ts:202` (deletion failure) and `:313` (stale
>     warm node with active workspaces); also `tests/workers/scheduled-node-cleanup.test.ts:1055`.
> - **Still open:**
>   - Gap 2: no tests for the timeout bounds or the null reset in
>     `apps/api/src/routes/projects/project-update.ts:198-216`.
>   - Gap 3: only the valid-workspace path is tested (`tests/unit/routes/terminal.test.ts:250`);
>     the missing-`workspaceId` 400 and no-`projectId` paths are not.
>   - Gap 4: no web test for saving timeouts. There is no "Save Timeouts" button any more: the
>     workspace timeout saves in `ProjectSettings.tsx:371`, the node idle timeout in
>     `ScalingSettings.tsx:171,340`.
> - **Moot/dropped:** gap 1's "lastActivity === 0" case; last activity is now at least the row's
>   `created_at` (`durable-objects/project-data/workspace-idle-timeouts.ts:46-47`).

**Created**: 2026-03-16
**Status**: backlog
**Priority**: high

## Problem

PR #408 (configurable compute lifecycle management) shipped with several test coverage gaps identified by the test coverage review agent after merge. The core idle timeout detection engine has zero behavioral tests — only source-contract and crash-resistance tests exist.

## Context

Discovered by `test-engineer` agent review of `sam/approach-its-simpler-signal-01kksx` branch. The implementation is correct and verified on staging, but automated test coverage is insufficient for the critical paths.

## Acceptance Criteria

- [ ] **Gap 1 (CRITICAL)**: `checkWorkspaceIdleTimeouts()` alarm path tested behaviorally in `project-data-do.test.ts` via `stub.alarm()`:
  - Workspace with stale activity beyond threshold is stopped
  - Workspace with recent terminal activity is NOT cleaned up
  - Project-level timeout override takes priority over env var default
  - Workspace with no activity recorded (lastActivity === 0) is NOT cleaned up
- [ ] **Gap 2 (HIGH)**: PATCH `/api/projects/:id` timeout validation tested:
  - Valid `workspaceIdleTimeoutMs` at MIN boundary returns 200
  - Below MIN returns 400
  - Above MAX returns 400
  - Same for `nodeIdleTimeoutMs`
  - `null` value clears setting (reverts to platform default)
- [ ] **Gap 3 (HIGH)**: `POST /api/terminal/activity` behavioral tests:
  - Missing `workspaceId` returns 400
  - Valid workspace calls `projectDataService.updateTerminalActivity`
  - Workspace without `projectId` returns `{ ok: true }` without calling DO
- [ ] **Gap 4 (MEDIUM)**: "Save Timeouts" button interaction test in web test suite
- [ ] **Gap 5 (MEDIUM)**: Node cleanup error-path tests (deleteNodeResources failure, stale warm node with running workspaces)

## Key Files

- `apps/api/tests/workers/project-data-do.test.ts` — Gap 1
- `apps/api/tests/unit/routes/projects.test.ts` — Gap 2
- `apps/api/tests/unit/routes/terminal.test.ts` — Gap 3
- `apps/web/tests/unit/pages/` — Gap 4
- `apps/api/tests/unit/node-cleanup.test.ts` — Gap 5

## Notes

- Gap 1 alarm test was blocked during implementation by pre-existing `@mastra/core` module resolution failure in workers test infrastructure — may still be blocked
- The idle timeout engine was verified manually on staging (slider interaction, alarm-driven cleanup)
