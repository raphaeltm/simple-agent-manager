# Task: Project & Task UX Redesign

**Date:** 2026-02-19
**Branch:** feat/project-ux-redesign

## Problem

Everything related to a project — header, edit form, task list, task detail panel, dependency editor, delegate dialog, and filters — is crammed onto a single `Project.tsx` page. This creates:

- Cognitive overload: too many concerns visible at once
- Cramped task detail: a side panel that can't breathe
- No deep-linkable task URLs: can't share/link to a specific task
- Poor information hierarchy: metadata and actions compete with content
- No progressive disclosure: all complexity surfaces at once

## Research Summary

Based on prior art from Linear, GitHub Projects, Jira, Asana, and NNG UX guidance, plus AI-agent-specific UX patterns (Smashing Magazine, Feb 2026).

### Key findings

**Linear** (most relevant — dev-focused, high UX rating) uses:
- Tabbed project pages: "Overview" tab (summary, counts, activity) + "Issues" tab (list)
- Task detail is a **separate full page** at its own URL
- Two-column task layout: content left (65%), metadata+actions right (35%)
- "Peek" pattern: Space bar to preview a task without leaving the list
- Modals only for atomic, self-contained actions (not for task detail)

**Industry consensus on containment**:

| Content | Container |
|---|---|
| Quick status/priority preview | Inline row chip |
| Task detail with editing, history, deps | **Full dedicated page** (own URL) |
| Dependency editing | Within task detail page sidebar |
| Atomic one-step action (delegate, confirm delete) | Modal dialog |

**Agentic AI specifics** (Smashing Magazine, Feb 2026):
- Intent preview before delegation (show agent what it will receive before confirming)
- Action audit log on task detail (chronological record of what the agent did)
- Failed/blocked tasks need high-visibility treatment at top of list ("Needs attention" section)
- Status must be the dominant visual signal in the list row

## Proposed Architecture

### Routing changes

Add a task detail route:
```
/projects/:projectId/tasks/:taskId   →  TaskDetail page
```

Keep existing:
```
/projects             →  Projects list
/projects/:id         →  Project page (tabbed)
```

### Project page → tabbed layout

Replace the single crammed page with two tabs:

**Overview tab** (default):
- Project name, description, repo@branch (read-only display)
- Task status summary: colored badge pills with counts (already done in #117)
- Linked workspaces count
- Edit project form (collapsible or on a sub-route)
- Recent activity (task status events, last N)

**Tasks tab**:
- Filter/sort toolbar (above list, not sidebar)
- "Needs attention" section: failed/blocked tasks pinned at top (if any)
- Task list with richer rows: status chip, priority indicator, title, blocking indicator ("blocked by 2"), assigned workspace name if delegated
- "New task" button in toolbar, opens inline create row or slide-out panel
- Click a task title → navigate to `/projects/:id/tasks/:taskId`

### Task detail page (`/projects/:id/tasks/:taskId`)

Dedicated page, URL-addressable and shareable. Breadcrumb navigation back to project.

**Two-column layout (desktop):**

Left column (60–65%):
- Title (editable inline)
- Status transition control (step-through stepper or dropdown)
- Description (rich text, read/edit)
- Output section (shown only when present): branch name, PR URL, output summary
- Activity/history log: status transitions with timestamps and actor (agent vs. manual)

Right sidebar (35–40%):
- Priority selector
- Created / updated timestamps
- Assigned workspace (name + link to workspace page)
- Dependencies section: list with status chips, search-to-add input, remove button per dep
- **[Delegate]** button → opens modal (keep existing `TaskDelegateDialog`)
- **[Cancel / Retry]** actions where applicable

**Mobile layout:** single column; right sidebar content collapses below main content.

### Delegate dialog

Keep as a modal — it's atomic (pick workspace → confirm). Improve it with an intent preview:
- Show the task title and description the agent will receive
- Show the target workspace and its current status
- Then "Delegate" confirm button

### Dependency management

Move out of the project list page entirely. Lives in the task detail page's right sidebar:
- Simple list of "depends on" tasks with status chips and links
- Search-to-add input for adding dependencies
- Remove button per dependency
- Remove `TaskDependencyEditor` component from the project page

### "Needs attention" section

At the top of the Tasks tab, show a compact list of tasks in `failed` or `blocked` state (blocked = `ready` status but has unresolved `blocked: true`). Use amber/red visual treatment. Can be dismissed individually.

## Files to touch

**New files:**
- `apps/web/src/pages/TaskDetail.tsx` — new task detail page
- `apps/web/src/components/project/TaskDetailPage.tsx` — (or inline in page) two-column layout
- `apps/web/src/components/project/NeedsAttentionSection.tsx` — failed/blocked callout

**Modified files:**
- `apps/web/src/App.tsx` — add `/projects/:id/tasks/:taskId` route
- `apps/web/src/pages/Project.tsx` — refactor to tabbed layout, remove detail panel, remove dependency editor
- `apps/web/src/components/project/TaskList.tsx` — richer rows, click title navigates
- `apps/web/src/components/project/TaskDetailPanel.tsx` — repurpose or delete (content moves to TaskDetail page)
- `apps/web/src/components/project/TaskDependencyEditor.tsx` — repurpose as inline sidebar widget
- `apps/web/src/components/project/TaskDelegateDialog.tsx` — add intent preview section
- `apps/web/src/components/project/TaskFilters.tsx` — move into Tasks tab toolbar

**Shared types** (no API changes needed — all data already available):
- No new API endpoints required; the task detail page uses existing `GET /api/projects/:id/tasks/:taskId` and `GET /api/projects/:id/tasks/:taskId/events`

## Checklist

- [ ] Add `/projects/:projectId/tasks/:taskId` route in `App.tsx`
- [ ] Create `TaskDetail` page with two-column layout (desktop) / single-column (mobile)
  - [ ] Title, status stepper, description, output section, activity log (left)
  - [ ] Priority, timestamps, workspace link, dependency sidebar widget (right)
  - [ ] Breadcrumb back to project
- [ ] Refactor `Project.tsx` to tabbed layout (Overview + Tasks tabs)
  - [ ] Overview tab: project metadata, badge pill summary, edit form, recent activity
  - [ ] Tasks tab: filter toolbar, needs-attention section, task list
- [ ] Update `TaskList.tsx`: click on task title → navigate to task detail page
- [ ] Add "Needs attention" section to Tasks tab (failed/blocked tasks)
- [ ] Repurpose `TaskDependencyEditor` as an inline sidebar widget for the task detail page
- [ ] Improve `TaskDelegateDialog` with intent preview (task description + workspace status)
- [ ] Remove `TaskDetailPanel` from `Project.tsx` (move to `TaskDetail` page)
- [ ] Move `TaskFilters` into Tasks tab toolbar
- [ ] Mobile layout verification (Playwright screenshots)
- [ ] Update tests for changed components

## References

- Linear conceptual model: https://linear.app/docs/conceptual-model
- Linear issue view layout: https://linear.app/changelog/2021-06-03-issue-view-layout
- NNG modal guidance: https://www.nngroup.com/articles/modal-nonmodal-dialog/
- Agentic AI UX patterns: https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/
- Current snapshot: `docs/notes/2026-02-18-current-state-projects-tasks-workspace-ui.md`
