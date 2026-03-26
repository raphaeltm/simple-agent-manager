# Project Notifications Page — Full Progress Update Viewing

## Problem

Progress update notifications from agents (via `update_task_status`) are truncated to 500 characters at **storage time** (`apps/api/src/routes/mcp/task-tools.ts:106`). The NotificationCenter UI further truncates with `line-clamp-2`. There is no way to see the full update text, and no per-project notifications view.

## Research Findings

### Backend
- **Double truncation**: Messages truncated at `task-tools.ts:106` (500 chars) AND `notification.ts:273` (500 chars again)
- **Metadata field**: Already exists as JSON TEXT column — can store `fullMessage` with zero schema changes
- **No project filter**: `listNotifications()` in the notification DO doesn't filter by `project_id`, despite the column + index existing
- **Notification DO schema** already has `project_id` column with index `idx_notifications_type`
- **Progress batching**: Within 5-min window, repeated updates UPDATE existing notification (not create new)
- **Cursor pagination**: Uses `created_at` timestamp as cursor

### Frontend
- **NotificationCenter.tsx**: Bell dropdown with `line-clamp-2` truncation, project grouping, read/dismiss actions
- **useNotifications hook**: WebSocket real-time updates, cursor pagination, optimistic updates
- **Project.tsx**: Outlet-based routing, chat vs non-chat layout detection
- **ProjectActivity.tsx**: Good pattern to follow — section container, ActivityFeed component, load-more pagination
- **API client**: `listNotifications()` supports `cursor`, `limit`, `filter`, `type` params — needs `projectId` added
- **Tab navigation**: Currently no shared tab bar in Project.tsx — tabs are implicit via routing

### Key Files
| File | Role |
|------|------|
| `apps/api/src/routes/mcp/task-tools.ts:106` | First truncation point |
| `apps/api/src/services/notification.ts:259` | `notifyProgress()` — second truncation, metadata construction |
| `apps/api/src/durable-objects/notification.ts:199` | `listNotifications()` — query builder |
| `apps/api/src/routes/notifications.ts:38` | GET endpoint — passes params to DO |
| `packages/shared/src/constants.ts:521` | `MAX_NOTIFICATION_BODY_LENGTH = 500` |
| `packages/shared/src/types.ts:1502` | Notification type definitions |
| `apps/web/src/components/NotificationCenter.tsx` | Bell dropdown UI |
| `apps/web/src/hooks/useNotifications.ts` | Notification hook with WebSocket |
| `apps/web/src/lib/api.ts:1503` | API client functions |
| `apps/web/src/pages/Project.tsx` | Project layout with Outlet |
| `apps/web/src/pages/ProjectActivity.tsx` | Pattern to follow |

## Implementation Checklist

### Phase 1: Backend — Store Full Text + Project Filter

- [ ] Add `MAX_NOTIFICATION_FULL_BODY_LENGTH = 5000` constant to `packages/shared/src/constants.ts`
- [ ] Update `notifyProgress()` in `notification.ts` to accept `fullMessage` option and store it in metadata
- [ ] Update `task-tools.ts` to pass untrimmed message as `fullMessage` (capped at 5000 chars)
- [ ] Add `projectId` query parameter support to `GET /api/notifications` route
- [ ] Add `projectId` filter to `listNotifications()` in notification DO
- [ ] Add `projectId` parameter to `listNotifications()` in `api.ts` client
- [ ] Build shared package after constant changes

### Phase 2: Frontend — Project Notifications Page

- [ ] Create `ProjectNotifications.tsx` page component
- [ ] Add route `/projects/:id/notifications` in `App.tsx`
- [ ] Add "Notifications" tab to project page navigation in `Project.tsx`
- [ ] Implement notification list with full-text display (metadata.fullMessage fallback to body)
- [ ] Add notification type filter chips
- [ ] Wire up cursor-based pagination with "Load more"
- [ ] Add expand/collapse for long messages (>5 lines)

### Phase 3: Polish — NotificationCenter Enhancement

- [ ] Add "View in project" link on notifications in the bell dropdown that navigates to project notifications page
- [ ] Add unread count badge on the Notifications tab (scoped to project via API)

### Phase 4: Tests

- [ ] Unit test: `notifyProgress()` stores fullMessage in metadata
- [ ] Unit test: `listNotifications()` filters by projectId
- [ ] Unit test: ProjectNotifications component renders with mock data
- [ ] Unit test: expand/collapse behavior for long messages

## Acceptance Criteria

- [ ] Full progress update text (up to 5000 chars) is preserved in notification metadata
- [ ] Existing notifications without fullMessage gracefully show truncated body
- [ ] `GET /api/notifications?projectId=xxx` returns only notifications for that project
- [ ] Project page has a "Notifications" tab between Activity and Settings
- [ ] Notifications page shows full message text with expand/collapse for long messages
- [ ] Type filter chips allow filtering by notification type
- [ ] Pagination works via cursor-based "Load more"
- [ ] Bell dropdown notifications link to the project notifications page
- [ ] No new hardcoded values (constitution Principle XI)
