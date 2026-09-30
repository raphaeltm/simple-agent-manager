# Notification Phase 2 — Performance & Correctness Follow-ups

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - Composite index `idx_notifications_task`
>     (`apps/api/src/durable-objects/notification-migrations.ts:52`).
>   - `projectName` is set in metadata by every notify helper
>     (`apps/api/src/services/notification.ts:153` and siblings) and read by
>     `apps/web/src/components/NotificationCenter.tsx:191`.
>   - The dead second `setNotifications` in `dismiss` is gone; `useNotifications` moved to TanStack
>     Query (PR #1872, `apps/web/src/hooks/useNotifications.ts:142-164`).
> - **Still open:**
>   - `isNotificationEnabled` still makes up to 3 queries per call
>     (`apps/api/src/durable-objects/notification.ts:424-481`), and it now runs twice per create
>     (in-app and web push, `:108-111`).
>   - `enforceLimit` still runs the age-based DELETE on every insert
>     (`notification.ts:245,695-704`).
>   - `stubResponse` still returns `id: 'suppressed'` (`notification.ts:659-675`). That id is now
>     load-bearing: `routes/mcp/instruction-tools.ts:663` compares against it, so update that
>     caller when tightening the type.
>   - Optional: `dismiss` still makes an extra unread-count HTTP call (`useNotifications.ts:145`).
> - **Moot/dropped:** the HIGH `waitUntil` item has moved to
>   `tasks/backlog/2026-03-19-mcp-notification-waituntil.md`, which now owns it.

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
