# Task Hierarchy Visualization in Project Chat

## Problem Statement

Users need to visualize the parent-child task hierarchy in project chat. When a task dispatches subtasks (agent-to-agent delegation), users can't easily see the full tree or navigate between related sessions. A working prototype on `prototype/task-hierarchy-ui` demonstrates the UX; this task ports it to production components wired to live data.

## Research Findings

### Existing Code
- **Prototype**: Branch `prototype/task-hierarchy-ui`, `apps/web/src/pages/hierarchy-prototype/index.tsx` (~1215 lines) + `mock-data.ts` (~466 lines). Demonstrates modal with SVG Bezier tree connectors, collapsible branches, text filtering, match highlighting, breadcrumbs, status summary.
- **`lineageUtils.ts`**: `isRetryOrFork()` classifies tasks — retries/forks are user-triggered with parentTaskId, subtasks have `triggeredBy=mcp` or `dispatchDepth>0`. Must share this logic.
- **`useTaskGroups.ts`**: `buildTaskInfoMap()` already builds `Map<taskId, TaskInfo>` from tasks API.
- **`sessionTree.ts`**: `buildSessionTree()` builds sidebar tree using same classification. Already uses `isRetryOrFork()`.
- **`SessionTreeItem.tsx`**: Recursive renderer for sidebar tree. Add hierarchy trigger button here.
- **`SessionSourceContextRow.tsx`**: Shows lineage breadcrumb for retries/forks. Can add "View hierarchy" link.
- **`Dialog.tsx`**: Wraps children in single `overflow-y-auto` div. Needs `stickyHeader` prop for fixed header + scrollable body.
- **`theme.css`**: Has dark (:root) and light (`[data-ui-theme='sam-light']`) tokens. No tree connector token exists.
- **`useProjectChatState.ts`**: Provides `taskInfoMap` already — no new API endpoint needed per adversarial review finding I4.
- **`time-utils.ts`**: Has `formatRelativeTime()` — reuse instead of duplicating.

### Key Architecture Decisions (from idea review)
- **No new API endpoint** — derive hierarchy client-side from existing `taskInfoMap` by walking `parentTaskId` chains (idea R1).
- **Extend Dialog** with `stickyHeader` prop rather than custom modal shell (idea R3, C3).
- **Lift collapse state** to modal level as `Map<taskId, boolean>` (idea C4).
- **Share `isRetryOrFork()`** with sidebar tree classification (idea C2).
- **All colors via CSS custom properties** — zero hardcoded hex values (idea C5).
- **New theme token** `--sam-color-tree-connector` for SVG lines (idea C6).

## Implementation Checklist

### 1. Theme Token
- [ ] Add `--sam-color-tree-connector` to `:root` (dark) in `theme.css`
- [ ] Add `--sam-color-tree-connector` to `[data-ui-theme='sam-light']` in `theme.css`

### 2. Dialog Extension
- [ ] Add `stickyHeader` prop to `Dialog` component in `packages/ui/src/components/Dialog.tsx`
- [ ] When `stickyHeader` is provided, render header outside the scrollable div with `flex-shrink: 0`
- [ ] Body content scrolls independently with `overflow-y-auto flex-1`

### 3. Hierarchy Tree Builder (client-side)
- [ ] Create `apps/web/src/components/task-hierarchy/buildHierarchyTree.ts`
- [ ] Function: `buildHierarchyTree(taskInfoMap, sessions, focusTaskId)` → `HierarchyNode` tree
- [ ] Walk `parentTaskId` chains up to find root, then walk down to find all descendants
- [ ] Use `isRetryOrFork()` from `lineageUtils.ts` for consistent classification
- [ ] Handle orphaned parents (partial chains) gracefully

### 4. Hierarchy Modal Component
- [ ] Create `apps/web/src/components/task-hierarchy/HierarchyModal.tsx`
- [ ] Use extended `Dialog` with `stickyHeader` for fixed header + scrollable body
- [ ] Replace ALL hardcoded hex colors with CSS custom properties
- [ ] Sticky header: title, node count, status summary, breadcrumbs, filter input
- [ ] Scrollable body: tree rendering

### 5. Tree Node Components
- [ ] Create `apps/web/src/components/task-hierarchy/HierarchyNodeCard.tsx`
- [ ] Handle tasks without sessions: disabled state + tooltip "Task is queued — no session yet"
- [ ] Guard `onNavigate` against null sessionId
- [ ] Create `apps/web/src/components/task-hierarchy/TreeConnector.tsx` (SVG)
- [ ] Use `var(--sam-color-tree-connector)` for connector stroke color
- [ ] Create `apps/web/src/components/task-hierarchy/HierarchyChildrenGroup.tsx`
- [ ] Collapsible groups with "Show N more" + status summary badges

### 6. State Management
- [ ] Lift collapse state to modal level as `Map<taskId, boolean>`
- [ ] Thread `isExpanded(taskId)` / `toggleExpanded(taskId)` as props
- [ ] Guard auto-scroll with `hasScrolledRef` — only on initial open
- [ ] Poll for updates every 3s while modal open + tasks non-terminal
- [ ] Preserve scroll position and collapse state across polls

### 7. Filter & Search
- [ ] Text filter prunes tree while preserving ancestor chains
- [ ] Collect and highlight direct match IDs (distinct from focus node)
- [ ] Auto-expand branches containing filter matches
- [ ] Show match count in header

### 8. Integration Points
- [ ] Add hierarchy trigger in `SessionTreeItem.tsx` — icon button with 44px+ touch target
- [ ] Only show when task has parent or children (check `taskInfoMap`)
- [ ] Add "View hierarchy" link in `SessionSourceContextRow.tsx`
- [ ] Wire navigation: clicking node navigates to session in project chat
- [ ] Use router navigation: `navigate(/projects/${projectId}/chat/${sessionId})`

### 9. Accessibility
- [ ] Dialog: `role="dialog"`, `aria-modal="true"` (inherited from Dialog component)
- [ ] Tree nodes: `role="treeitem"`, `aria-expanded` on collapsible nodes
- [ ] Filter input: `aria-label="Filter tasks"`, announce result count
- [ ] Focus trapping within modal (inherited from Dialog)
- [ ] 44px minimum touch targets on all interactive elements
- [ ] Focus visible ring on keyboard navigation

### 10. Mobile UX
- [ ] Test at 375px viewport — modal should use max-height with minimal padding
- [ ] Ensure touch targets are 44px+
- [ ] Consider compact card layout for deeper nesting levels

### 11. Testing
- [ ] Unit tests for `buildHierarchyTree` — various tree shapes, orphans, retries vs subtasks
- [ ] Unit tests for filter logic — matching, ancestor preservation, match ID collection
- [ ] Component tests for HierarchyModal — render, filter, navigate, collapse/expand
- [ ] Playwright visual audit at mobile (375px) and desktop (1280px) viewports

## Acceptance Criteria
- [ ] Hierarchy modal opens from project chat when clicking hierarchy icon on a session with parent/child tasks
- [ ] Shows full tree from root to all leaves with SVG connectors
- [ ] Current session's task is highlighted as focus node
- [ ] Clicking a navigable node goes to that session in project chat
- [ ] Tasks without sessions show disabled state with tooltip
- [ ] Text filter prunes tree while preserving ancestor chains
- [ ] Filter matches are visually highlighted
- [ ] Collapsed branches auto-expand when filter matches exist inside
- [ ] Status summary shows counts by status category
- [ ] Tree updates while modal is open and tasks are active (polling)
- [ ] Works in both dark and light mode (all colors via CSS custom properties)
- [ ] Responsive: works on mobile (375px) and desktop (1280px)
- [ ] Uses existing Dialog component with stickyHeader extension
- [ ] Accessible: ARIA roles, focus trapping, 44px touch targets
- [ ] Shares `isRetryOrFork()` classification with sidebar tree
- [ ] Collapse state survives data refetches
- [ ] No prototype routes shipped to production

## References
- Prototype: `prototype/task-hierarchy-ui` branch
- SAM idea: `01KTSE3ZZBDQ53CR0FACAABP5H`
- `apps/web/src/pages/project-chat/lineageUtils.ts`
- `apps/web/src/pages/project-chat/useTaskGroups.ts`
- `apps/web/src/pages/project-chat/sessionTree.ts`
- `apps/web/src/pages/project-chat/SessionTreeItem.tsx`
- `packages/ui/src/components/Dialog.tsx`
- `packages/ui/src/tokens/theme.css`
