# Notification System — Security Follow-ups

**Created**: 2026-03-16
**Source**: Late-arriving security-auditor review of PR #420 (merged)
**Priority**: High

## Problem Statement

Post-merge security audit identified authentication gaps in the Notification DO WebSocket handler and insufficient input validation at the DO trust boundary.

## Findings

### HIGH — Unauthenticated WebSocket in Notification DO

**Location**: `apps/api/src/durable-objects/notification.ts:370-385`
**Description**: The DO's `fetch()` handler accepts any WebSocket upgrade with no auth check. The API route requires `requireAuth()` before forwarding, but the DO itself is unguarded. If the DO URL is ever directly accessible (misconfigured binding, future routing), any caller can receive all real-time notifications for that user.
**Fix**: Pass a short-lived nonce from the API route to the DO upgrade request and validate it in the DO's `fetch()`. Alternatively, verify forwarded `X-User-Id` header matches `idFromName(userId)`.

### HIGH — `actionUrl` validation too permissive

**Location**: `apps/api/src/durable-objects/notification.ts:73-75`, `apps/web/src/components/NotificationCenter.tsx:88-91`
**Description**: Only checks `startsWith('/')` — paths like `/@evil` or `/../../../` pass. Client navigates to the URL via React Router.
**Fix**: Tighten to explicit allowlist regex matching `/projects/`, `/tasks/`, or other known app paths. Apply in both DO and frontend.

### MEDIUM — `type`/`urgency` not runtime-validated in DO

**Location**: `apps/api/src/durable-objects/notification.ts:128-143`
**Description**: `createNotification` inserts `type` and `urgency` directly without validating against `NOTIFICATION_TYPES`/`NOTIFICATION_URGENCIES` enums. TypeScript types are compile-time only; the DO is a trust boundary.
**Fix**: Add `NOTIFICATION_TYPES.includes(request.type)` check before INSERT.

### MEDIUM — `notificationType` not validated in `updatePreference`

**Location**: `apps/api/src/durable-objects/notification.ts:294-313`
**Description**: Accepts arbitrary strings for `notificationType` and `channel`. API route validates, but DO method is a direct RPC entry point.
**Fix**: Mirror API route validation in the DO method.

### MEDIUM — No dedup window for `needs_input` notifications

**Description**: `task_complete` has a 60-second dedup window, but `needs_input` has none. A runaway agent can flood 120 high-urgency notifications/minute.
**Fix**: Add dedup window for `needs_input` (e.g., 5 minutes per task, same pattern as `task_complete`).

### LOW — `cursor` parameter parsed without bounds checking

**Location**: `apps/api/src/durable-objects/notification.ts:198-202`
**Description**: `parseInt` on non-numeric string returns `NaN` → SQLite converts to 0 → silently returns empty results.
**Fix**: Validate numeric before parsing, return 400 on invalid cursor.

### LOW — No WebSocket message size guard before JSON.parse

**Location**: `apps/api/src/durable-objects/notification.ts:387-399`
**Description**: No explicit size limit before parsing incoming WS messages. CF has 1MB implicit limit but defence-in-depth recommends `message.length > 1024` guard.

### LOW — `metadata: Record<string, unknown>` allows untyped agent content to reach UI

**Description**: Future callers could populate `metadata.projectName` from agent-supplied content. Should define typed `NotificationMetadata` interface.

## Acceptance Criteria

- [ ] DO WebSocket handler authenticates connecting clients (nonce or header validation)
- [ ] `actionUrl` validation uses path allowlist, not just `startsWith('/')`
- [ ] `type` and `urgency` runtime-validated against enums in DO
- [ ] `notificationType` and `channel` validated in `updatePreference` DO method
- [ ] `needs_input` dedup window implemented
- [ ] `cursor` parameter validated before parseInt
- [ ] WS message size guard added
- [ ] `NotificationMetadata` typed interface replaces `Record<string, unknown>`
