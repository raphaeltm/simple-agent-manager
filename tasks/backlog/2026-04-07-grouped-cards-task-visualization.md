# Grouped Cards Task Relationship Visualization

## Problem

The project chat session list sidebar shows all sessions as a flat list. When tasks have parent-child relationships (sub-tasks), there's no visual indication of hierarchy. Users can't see which tasks are sub-tasks, how many sub-tasks a parent has, or sub-task completion progress.

## Research Findings

### Current Architecture
- `useProjectChatState.ts` loads sessions via `listChatSessions()` and tasks via `listProjectTasks()`. Tasks are used to build a `taskTitleMap` (Map<taskId, title>) for display.
- `SessionItem.tsx` renders each session as a flat item with status dot, topic/title, state label, message count, and relative timestamp.
- `MobileSessionDrawer.tsx` mirrors the desktop sidebar with same `SessionItem` usage.
- Sessions have `taskId` linking to tasks. Tasks have `parentTaskId` for hierarchy, `status`, and `blocked` fields.
- `listProjectTasks()` returns full `Task` objects including `parentTaskId`, `status`, `blocked`.

### Data Available
- `Task.parentTaskId` — already returned by `listProjectTasks`
- `Task.status` — already returned
- `Task.blocked` — available on `TaskDetailResponse` but may not be on list response
- Task dependencies with blocked-by info — requires `getProjectTask(id)` for detail

### Design Spec (from idea 01KNKE93C7G3P6W68MTFPP8MAD)
- Parent tasks: `border-left: 3px solid var(--accent)`, `background: var(--surface)`, 13px/500 font
- Child tasks: `border-left: 3px solid rgba(22,163,74,0.25)`, `background: rgba(22,163,74,0.03)`, 12px/400 font
- Task group card: `border: 1px solid var(--border-subtle)`, `border-radius: 10px`
- Collapsible "Show N sub-tasks" / "Hide sub-tasks" toggle
- Progress bar on parent showing completed/total
- "N SUB" badge on parent title
- BLOCKED badge + "Waiting on: [task name]" on blocked children
- Groups default to collapsed

### Files to Modify
- `apps/web/src/pages/project-chat/useProjectChatState.ts` — extend task data loading to build parent-child map
- `apps/web/src/pages/project-chat/index.tsx` — render grouped sessions
- `apps/web/src/pages/project-chat/SessionItem.tsx` — add variant support for child rendering
- `apps/web/src/pages/project-chat/MobileSessionDrawer.tsx` — same grouping in mobile drawer
- NEW: `apps/web/src/pages/project-chat/TaskGroup.tsx` — grouped card wrapper component
- NEW: `apps/web/src/pages/project-chat/SubTaskProgressBar.tsx` — progress bar sub-component

## Implementation Checklist

- [ ] 1. Extend `useProjectChatState` to build task relationship data (parentChildMap, taskStatusMap, childCountMap)
- [ ] 2. Create `SubTaskProgressBar` component
- [ ] 3. Create `TaskGroup` wrapper component with expand/collapse, progress bar, badges
- [ ] 4. Modify `SessionItem` to support parent/child variants (font size, colors, border-left)
- [ ] 5. Update desktop sidebar session list rendering to use `TaskGroup` for grouped sessions
- [ ] 6. Update `MobileSessionDrawer` to use same grouping logic
- [ ] 7. Implement search behavior: expand parent group when child matches search
- [ ] 8. Add unit tests for grouping logic
- [ ] 9. Add Playwright visual audit tests (mobile + desktop, diverse mock data)

## Acceptance Criteria

- [ ] Tasks with sub-tasks are visually grouped in a card container
- [ ] Parent has strong green left accent strip; children have faded green strip + faint green background
- [ ] No indentation — hierarchy via color banding and container grouping
- [ ] Children use smaller font (12px/400) vs parent (13px/500)
- [ ] Parent shows progress bar with completion count (e.g., "1/3")
- [ ] Parent shows "N SUB" badge when it has children
- [ ] Groups are collapsible with "Show N sub-tasks" / "Hide sub-tasks" toggle
- [ ] Groups default to collapsed state
- [ ] Blocked children show "BLOCKED" badge and "Waiting on: [task name]" in meta
- [ ] Standalone tasks (no parent, no children) render unchanged
- [ ] Clicking a child selects it and opens its session
- [ ] Clicking the expand bar toggles children without selecting
- [ ] Search that matches a child expands its parent group
- [ ] Works on mobile (375px) and desktop (1280px) viewports
- [ ] No horizontal overflow on any viewport
- [ ] Playwright visual audit passes with diverse mock data

## References

- Idea: 01KNKE93C7G3P6W68MTFPP8MAD
- Prototype: prototype/task-relationships/index.html (View A)
- Task ID: 01KNKE9NAY41C6A0JSM6VNWPR8
