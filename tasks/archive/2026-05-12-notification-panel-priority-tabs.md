# Notification Panel Priority Tabs

## Problem

The notification panel currently has two tabs: "All" and "Unread". With agents producing many status updates, the panel becomes noisy and users can't quickly find what matters — specifically, agents requesting human input and completed tasks.

## Research Findings

### Current Architecture
- **Component**: `apps/web/src/components/NotificationCenter.tsx` (446 lines)
- **Hook**: `apps/web/src/hooks/useNotifications.ts` — fetches from API, manages WebSocket for real-time updates
- **Types**: `packages/shared/src/types/notification.ts` — `NotificationType` = `task_complete | needs_input | error | progress | session_ended | pr_created`
- **Urgency mapping** (`packages/shared/src/constants/notifications.ts`):
  - `high`: `needs_input`, `error`
  - `medium`: `task_complete`, `session_ended`, `pr_created`
  - `low`: `progress`
- **Filter tab type**: `type FilterTab = 'all' | 'unread'` — purely client-side filtering on the fetched notifications array

### Design Decision
User wants 3 tabs:
1. **Priority** — `needs_input` + `task_complete` (agents needing input + finished tasks)
2. **Updates** — everything else (`progress`, `session_ended`, `pr_created`, `error`)
3. **All** — all notifications (current behavior)

The "Unread" filter is removed as a separate tab. Instead, the unread count badge remains on the bell icon.

### No API Changes Required
Filtering is purely client-side — the hook fetches all notifications and the component filters them. The `FilterTab` type just needs a third option.

## Implementation Checklist

- [ ] Update `FilterTab` type to `'priority' | 'updates' | 'all'`
- [ ] Define `PRIORITY_TYPES` constant: `['needs_input', 'task_complete']`
- [ ] Update filtering logic in `filteredNotifications` to handle the 3 tabs
- [ ] Update tab rendering to show 3 tabs with appropriate labels
- [ ] Add priority count badge on the Priority tab (count of unread priority notifications)
- [ ] Update empty state messages for each tab
- [ ] Default active tab to `'priority'` instead of `'all'`
- [ ] Create standalone HTML prototype with mock data for visual review
- [ ] Run Playwright visual audit (mobile 375px + desktop 1280px)
- [ ] Add/update unit tests for the filtering logic
- [ ] Verify no horizontal overflow on mobile

## Acceptance Criteria

- [ ] Three tabs visible: "Priority", "Updates", "All"
- [ ] Priority tab shows only `needs_input` and `task_complete` notifications
- [ ] Updates tab shows `progress`, `session_ended`, `pr_created`, and `error` notifications
- [ ] All tab shows everything (unchanged from current behavior)
- [ ] Each tab shows appropriate empty state when no matching notifications exist
- [ ] Priority tab is the default when opening the panel
- [ ] Unread badge count on bell icon still reflects total unread count
- [ ] Panel looks good on mobile (375px) and desktop (1280px)
- [ ] No horizontal overflow on any viewport
