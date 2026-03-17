# Fix Notification Links to Chat Sessions

## Problem

Notifications don't properly link to their associated chat sessions. All notification `actionUrl` values point to `/projects/${projectId}` (the project page), even when a `sessionId` is available. The route `/projects/:id/chat/:sessionId` exists in the app router, but notifications never use it.

When a user clicks a notification (e.g., "Agent finished", "Needs input", "Task completed"), they land on the project page instead of the specific chat session where the conversation happened.

## Research Findings

### Key Files
- `apps/api/src/services/notification.ts` — All 6 notification helper functions construct `actionUrl`
- `apps/web/src/components/NotificationCenter.tsx` — `handleNotificationClick` navigates to `notification.actionUrl`
- `apps/web/src/App.tsx` — Route `/projects/:id/chat/:sessionId` exists

### Current actionUrl by notification type
| Type | Current actionUrl | sessionId available? |
|------|-------------------|---------------------|
| `task_complete` | `/projects/${projectId}` | Yes (optional) |
| `error` (task_failed) | `/projects/${projectId}` | Yes (optional) |
| `session_ended` | `/projects/${projectId}` | Yes |
| `pr_created` | `/projects/${projectId}` | No |
| `needs_input` | `/projects/${projectId}?task=${taskId}` | Yes (optional) |
| `progress` | `/projects/${projectId}` | Yes (optional) |

### Root Cause
The `actionUrl` construction in each notification helper ignores the `sessionId` parameter entirely. The session ID is stored on the notification record but never incorporated into the URL.

### Fix
When `sessionId` is truthy, use `/projects/${projectId}/chat/${sessionId}` instead of `/projects/${projectId}`. No frontend changes needed — `handleNotificationClick` already navigates to `actionUrl`, and the route exists.

## Implementation Checklist

- [ ] Add `buildActionUrl` helper in `notification.ts` that returns `/projects/${projectId}/chat/${sessionId}` when sessionId is truthy, else `/projects/${projectId}`
- [ ] Update `notifyTaskComplete` to use helper
- [ ] Update `notifyTaskFailed` to use helper
- [ ] Update `notifySessionEnded` to use helper
- [ ] Update `notifyNeedsInput` to use helper (keep `?task=` param for backwards compat)
- [ ] Update `notifyProgress` to use helper
- [ ] `notifyPrCreated` — no sessionId param, no change needed
- [ ] Update existing tests to expect new actionUrl values when sessionId is provided
- [ ] Add test: actionUrl includes sessionId when provided
- [ ] Add test: actionUrl falls back to project URL when sessionId is null/undefined/empty

## Acceptance Criteria

- [ ] Clicking a notification with a sessionId navigates to `/projects/:id/chat/:sessionId`
- [ ] Clicking a notification without a sessionId navigates to `/projects/:id` (unchanged)
- [ ] All existing notification tests pass with updated expectations
- [ ] New regression tests verify the sessionId-in-URL behavior
