# Notification Phase 2 — Performance & Correctness Follow-ups

**Created**: 2026-03-16
**Source**: Late-arriving cloudflare-specialist review of PR #420 (merged)
**Priority**: Medium

## Problem Statement

Post-merge review of notification Phase 2 identified several performance optimizations and minor correctness gaps in the Notification DO, MCP route handlers, and NotificationCenter UI.

## Findings

### HIGH — `waitUntil` for notification DO calls in MCP routes

**Already deferred in Phase 5 review.** The four MCP notification call sites (`handleUpdateTaskStatus`, `handleCompleteTask` x2, `handleRequestHumanInput`) `await` the Notification DO round-trip, blocking the MCP response to the agent. Should use `ctx.waitUntil()` pattern like `tasks/crud.ts` does. Requires passing `ExecutionContext` into handler functions.

**Location**: `apps/api/src/routes/mcp.ts:651`, `:754`, `:830`, `:914`

### MEDIUM — `isNotificationEnabled` three-query waterfall

The preference lookup issues up to 3 separate SQL queries (project-specific, type-global, wildcard) on every `createNotification` call. Should collapse to a single `UNION ALL` or `ORDER BY priority LIMIT 1` query.

**Location**: `apps/api/src/durable-objects/notification.ts:316–364`

### MEDIUM — `enforceLimit` age-based DELETE on every insert

The age-based `DELETE` in `enforceLimit` runs on every notification insert. Should be rate-limited (once per hour) or moved to a DO alarm.

**Location**: `apps/api/src/durable-objects/notification.ts:456–488`

### LOW — Missing composite index for task_id queries

Progress-batch and dedup queries filter by `task_id` but the existing index doesn't include it. Add `(user_id, type, task_id, created_at DESC)` index.

### LOW — `projectName` never set in notification metadata

`NotificationCenter.tsx` reads `projectName` from metadata but no notification helper sets it. All group headers show "Project" fallback. Either pass `projectName` at creation time or look up from projects API.

### LOW — Dead `setNotifications` call in `useNotifications.ts:dismiss`

Second `setNotifications` call is a no-op. The `getNotificationUnreadCount()` HTTP call may also be redundant if WS `notification.unread_count` message covers it.

### LOW — `stubResponse` return type leaks synthetic ID

`createNotification` returns `{ id: 'suppressed' }` for suppressed notifications. Should use `null` or a discriminated union to prevent accidental use of the synthetic ID.

## Acceptance Criteria

- [ ] MCP notification calls use `waitUntil` pattern (not blocking agent response)
- [ ] `isNotificationEnabled` uses single SQL query
- [ ] `enforceLimit` age-based cleanup is rate-limited
- [ ] Composite index added for task_id queries
- [ ] Project names display correctly in notification grouping
- [ ] Dead code removed from dismiss handler
- [ ] `stubResponse` type tightened
