# Notification Phase 2 — Test Coverage Gaps

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - Gap 11: all three preference tiers are tested
>     (`apps/api/tests/unit/durable-objects/notification-preferences.test.ts:256-336`).
>   - Gap 1: generic body (`apps/api/tests/unit/services/notification.test.ts:188`).
>   - Gap 22, tab filter: `apps/web/tests/unit/components/notification-grouping.test.tsx:468-584`.
>   - Gaps 16/17, partly: the real hook with a fake WebSocket covers `notification.new`,
>     `notification.unread_count` and malformed frames
>     (`apps/web/tests/unit/hooks/useNotifications-malformed.test.ts:58-178`).
> - **Still open:**
>   - Gap 6: the task-mode `complete_task` notification is never asserted. `mcp.test.ts:4664+`
>     covers `update_task_status` and conversation mode; `mcp-complete-task-cleanup.test.ts:53`
>     only mocks it.
>   - Gap 14: `enforceLimit` eviction.
>   - Gap 9: options count cap and truncation
>     (`apps/api/src/routes/mcp/instruction-tools.ts:575-576`).
>   - Gap 12: `actionUrl` stripping in the DO (only the web-push path is tested).
>   - Gap 19: `handleNotificationClick`.
>   - Gaps 16/17, rest: `updated`, `read`, `dismissed` and `all_read` through the real hook
>     (`notification-grouping.test.tsx:332-384` still mocks the hook).
>   - Gaps 20, 21 and 23: mark-all-read, load-more and Escape/click-outside in `NotificationCenter`.
>   - Medium gaps 3, 7/8, 13 and 15: not re-checked; keep.
>   - Test item carried over from the phase-1 follow-ups file (end of this file).
> - **Moot/dropped:**
>   - Gap 10: non-string options are now rejected, and that is tested (`mcp.test.ts`, "should
>     reject options array with non-string elements").
>   - Gap 18: the dead `dismiss` code was removed (PR #1872).
>   - The `/tmp/claude-1000/...` transcript linked under Notes no longer exists.

**Created**: 2026-03-16
**Source**: Late-arriving test-engineer review of PR #420 (merged)
**Priority**: High (regression holes in new Phase 2 paths)

## Problem Statement

Post-merge test coverage analysis identified 23 gaps across 4 test files. Three critical gaps represent direct regression holes for Phase 2 features.

## Critical Gaps (Would Miss a Real Regression)

### Gap 6 — `complete_task` (task mode) notification side-effect not asserted
**File**: `apps/api/tests/unit/routes/mcp.test.ts`
**Issue**: The `notification side-effects` describe block tests `update_task_status` and conversation-mode `complete_task` but omits task-mode completion — the primary `notifyTaskComplete` trigger.

### Gap 11 — `isNotificationEnabled` guard entirely untested
**File**: `apps/api/tests/unit/durable-objects/notification-suppression.test.ts`
**Issue**: The first check in `createNotification` controls whether suppression logic runs. Zero test coverage for preference-based suppression, including the three-tier lookup order (project-specific → type-global → wildcard).

### Gaps 16/17 — WebSocket `onmessage` handler in `useNotifications` entirely untested
**File**: `apps/web/tests/unit/components/notification-grouping.test.tsx`
**Issue**: The `notification.updated` test mocks the hook entirely, not the socket. None of the WS message cases (`notification.new`, `notification.read`, `notification.dismissed`, `notification.all_read`, `notification.unread_count`, `notification.updated`) are exercised through the real hook code.

### Gap 14 — `enforceLimit` eviction logic has no coverage
**File**: `apps/api/tests/unit/durable-objects/notification-suppression.test.ts`
**Issue**: MockSqlStorage returns `[]` for DELETE/COUNT queries so `enforceLimit` is always a no-op. The eviction priority logic (dismissed first, then read, then unread) is never verified.

## High Gaps (Reduces Regression Safety)

### Gap 1 — `notifyTaskComplete` "no output" body branch untested
**File**: `apps/api/tests/unit/services/notification.test.ts`
**Test**: Assert `body === 'Task finished successfully'` when neither PR URL nor branch provided.

### Gap 9 — Options count cap and per-option length truncation untested
**File**: `apps/api/tests/unit/routes/mcp.test.ts`
**Test**: Pass 20 options, verify only `MAX_HUMAN_INPUT_OPTIONS_COUNT` kept. Pass 500-char option, verify truncated.

### Gap 10 — All-non-string options → `null` metadata path untested
**File**: `apps/api/tests/unit/routes/mcp.test.ts`
**Test**: Pass `options: [42, null, true]`, verify notification metadata has `options: null`.

### Gap 12 — Absolute `actionUrl` stripping guard untested
**File**: `apps/api/tests/unit/durable-objects/notification-suppression.test.ts`
**Test**: Pass `actionUrl: 'https://evil.com'`, verify stored as `null`.

### Gap 19 — `handleNotificationClick` interaction untested
**File**: `apps/web/tests/unit/components/notification-grouping.test.tsx`
**Test**: Click unread notification, assert `markRead` called. Click read notification, assert not called.

## Medium Gaps

- Gap 3: `sessionId` propagation not asserted for `notifyNeedsInput`/`notifyProgress`
- Gap 7/8: `NOTIFICATION` binding absent guard; null `task.userId` guard untested
- Gap 13: Broadcast calls during batch update not verified
- Gap 15: `getNotificationById` null fallback after UPDATE untested
- Gap 18: `dismiss` dead-code second `setNotifications` untested
- Gaps 20-23: Mark-all-read button, load-more, tab filter, escape/click-outside untested

## Acceptance Criteria

- [ ] `complete_task` task-mode notification side-effect tested
- [ ] `isNotificationEnabled` preference guard tested (all three tiers)
- [ ] `useNotifications` WebSocket `onmessage` handler tested through real hook
- [ ] `enforceLimit` eviction logic tested with >max rows
- [ ] Options count cap and length truncation tested
- [ ] `actionUrl` stripping tested
- [ ] `handleNotificationClick` interaction tested
- [ ] Mark-all-read, load-more, tab filter interactions tested

## Notes

The review output includes concrete test code for each gap — see full transcript at `/tmp/claude-1000/-workspaces-simple-agent-manager/tasks/a30c0a08fb4381d13.output` for copy-paste test implementations.

## Carried over 2026-09-30

From `2026-03-16-notification-system-phase1-followups` (removed from the backlog 2026-09-30; see git history), dissolved in the
2026-09-30 weekly queue audit:

- [ ] `useNotifications` reconnection test: drop the WebSocket and assert the hook reconnects with
      backoff (`apps/web/src/hooks/useNotifications.ts:282-311`). No such test exists today.
