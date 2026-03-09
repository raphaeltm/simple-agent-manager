# Fix Task Status Display in Dashboard

## Problem

Tasks in the project dashboard always appear as "active" regardless of their actual status. Two issues contribute:

1. **Dashboard only shows active tasks**: The "Active Tasks" section filters to `queued`, `delegated`, `in_progress` statuses only. Completed/failed tasks simply disappear — users never see the transition.

2. **Confusing "Active"/"Idle" label**: The `ActiveTaskCard` shows an "Active"/"Idle" indicator based on message recency (`isActive` field), which can be confused with the task's actual status. Combined with the "Active Tasks" section heading, this creates a misleading impression that all tasks are permanently "active".

## Research Findings

### Key Files
- `apps/web/src/pages/Dashboard.tsx` — Dashboard "Active Tasks" section
- `apps/web/src/components/ActiveTaskCard.tsx` — Task card with confusing "Active"/"Idle" label
- `apps/api/src/routes/dashboard.ts` — Dashboard API (filters to `ACTIVE_TASK_STATUSES`)
- `apps/web/src/components/project/ProjectInfoPanel.tsx` — Project sidebar showing "Recent Tasks"
- `apps/api/src/routes/mcp.ts` — MCP `complete_task` handler (works correctly)
- `packages/ui/src/components/StatusBadge.tsx` — Status badge component (correct labels)

### How Task Completion Works
- MCP `complete_task()` tool: Agent explicitly calls it → D1 update
- ProjectData DO `completeTaskInD1()`: Called when session is stopped
- Stuck-tasks cron: Safety net for tasks exceeding timeout
- All paths correctly update D1 status

### Root Cause
The MCP server correctly updates task status. The issue is UX: completed tasks disappear from the dashboard and the "Active"/"Idle" label creates confusion.

## Implementation Checklist

- [ ] Add API endpoint `GET /api/dashboard/recent-tasks` returning recently completed/failed/cancelled tasks
- [ ] Add "Recently Completed" section to Dashboard below "Active Tasks"
- [ ] Rename "Active"/"Idle" indicator to "Responding"/"Idle" on ActiveTaskCard to disambiguate from task status
- [ ] Write unit tests for the new dashboard endpoint
- [ ] Write behavioral tests for the new Dashboard section
- [ ] Run full quality suite (lint, typecheck, test, build)

## Acceptance Criteria

- [ ] Dashboard shows recently completed/failed tasks (last 24h or last 10, whichever is fewer)
- [ ] Users can see task lifecycle transitions (not just active tasks)
- [ ] "Active"/"Idle" label no longer confuses with task status
- [ ] Existing task card behavior preserved
- [ ] All tests pass
