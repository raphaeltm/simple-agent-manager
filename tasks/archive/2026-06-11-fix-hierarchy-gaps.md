# Fix Task Hierarchy Gaps & Remove Touch-Target Mandates

## Problem

The task hierarchy feature shipped with four divergences from the prototype/user request, plus agent rules mandate oversized touch targets that the user explicitly dislikes.

## Research Findings

### 1. Routing/history-based hierarchy modal
- Current: `apps/web/src/pages/project-chat/index.tsx:25` uses `useState<string|null>` for `hierarchyTaskId`
- Problem: Browser Back navigates away from page; no way to return to graph after clicking a node
- Fix: Derive modal visibility from `location.hash` (`#hierarchy-<taskId>`); open via `navigate(hash)`; close via `navigate(-1)`
- Reference: prototype (`hierarchy-prototype/index.tsx:1077-1108`) uses exactly this pattern

### 2. Remove nested expand/collapse tree
- Current: `SessionTreeItem.tsx` renders recursive tree with chevron expand/collapse badges (`expandToggleBadge`), indentation (`INDENT_PX`, `MAX_VISUAL_DEPTH`), and auto-expand logic
- `sessionTree.ts` builds full parent-child forest with `buildSessionTree()`
- `SessionList.tsx` uses `buildSessionTree` and renders `SessionTreeItem` recursively
- Fix: Flatten the session list - remove tree nesting, children rendering, expand/collapse UI. Keep `buildSessionTree` only for root-level lineage text computation (retries/forks). The hierarchy modal becomes the only way to explore parent/child.

### 3. Role-differentiated hierarchy icons
- Current: `SessionTreeItem.tsx:144-164` uses uniform `Network` icon with `--sam-color-info` for all sessions
- Fix: Port prototype's `HierarchyIndicator` which uses:
  - GitBranch (blue) for parent-only
  - GitMerge (purple) for child-only
  - Network (amber) for both
- Role detection: check `taskInfoMap` for `parentTaskId` (child) and whether any other task has this as parent (isParent)

### 4. Filter always visible in HierarchyModal
- `HierarchyModal.tsx:267-299`: filter input gated by `totalNodes > 5`
- Fix: Remove the `totalNodes > 5` gate around the filter input (lines 277-299)

### 5. Touch-target mandate removal
Files to update:
- `.claude/rules/17-ui-visual-testing.md` line ~50: "Touch target size — interactive elements are at least 44x44px..."
- `.claude/rules/04-ui-standards.md`: "min 56px touch targets" (lines 1, 13, 31, 35, 48-49)
- `.claude/agents/ui-ux-specialist/UI_UX_SPECIALIST.md`: lines ~31 and ~73 (44px/56px checks)
- `.claude/skills/prototype/SKILL.md` line 66: "touch targets (44px+ min)"
- `.agents/skills/prototype/SKILL.md` line 65: "touch targets (44px+ min)"

## Implementation Checklist

- [ ] 1. Hash-based hierarchy modal routing
  - [ ] Import `useLocation` in `project-chat/index.tsx`
  - [ ] Derive `hierarchyTaskId` from `location.hash` instead of `useState`
  - [ ] `handleShowHierarchy` navigates to `#hierarchy-<taskId>`
  - [ ] `handleHierarchyNavigate` navigates to session then `navigate(-1)` to remove hash
  - [ ] Close modal via `navigate(-1)`
  - [ ] Test: browser Back from session returns to graph

- [ ] 2. Flatten session list (remove tree nesting)
  - [ ] Simplify `SessionTreeItem.tsx` to `SessionListItem` (flat, no children/expand/indent)
  - [ ] Remove `expandToggleBadge`, `MAX_VISUAL_DEPTH`, `INDENT_PX`, recursive children rendering
  - [ ] Remove `treeHasMatchingDescendant` and `nodeMatches` from sessionTree.ts (dead code)
  - [ ] Simplify `SessionList.tsx` - render flat list, no tree building for nesting
  - [ ] All sessions visible in flat list with normal recency ordering
  - [ ] Keep lineageText for retries/forks (subtitle display)
  - [ ] Update `MobileSessionDrawer.tsx` if needed

- [ ] 3. Role-differentiated hierarchy icons
  - [ ] Create `getHierarchyRole()` function using taskInfoMap
  - [ ] Create `HierarchyIndicator` component with GitBranch/GitMerge/Network icons
  - [ ] Use theme tokens for colors (blue=info, purple=custom, amber=warning)
  - [ ] Distinct tooltips/aria-labels per role
  - [ ] Compact size (max 22px)
  - [ ] Replace uniform Network icon in session items

- [ ] 4. Filter always visible in HierarchyModal
  - [ ] Remove `totalNodes > 5` gate around filter input (keep status summary gate)

- [ ] 5. Remove touch-target mandates from agent definitions
  - [ ] Update `.claude/rules/17-ui-visual-testing.md`
  - [ ] Update `.claude/rules/04-ui-standards.md`
  - [ ] Update `.claude/agents/ui-ux-specialist/UI_UX_SPECIALIST.md`
  - [ ] Update `.claude/skills/prototype/SKILL.md`
  - [ ] Update `.agents/skills/prototype/SKILL.md`

- [ ] 6. Tests
  - [ ] Behavioral test for hash-based modal routing
  - [ ] Test for flat session list rendering
  - [ ] Test for role-differentiated icons (parent/child/both/none)
  - [ ] Test for filter always visible

- [ ] 7. Playwright visual audit (mobile 375px + desktop 1280px)

## Acceptance Criteria

1. Opening hierarchy modal adds `#hierarchy-<taskId>` to URL; browser Back closes it
2. Clicking a node in the graph navigates to that session; browser Back returns to the graph
3. Session list is flat — no expand/collapse chevrons, no indentation, no nested children
4. All sessions (including previously hidden subtask children) appear in the flat list
5. Hierarchy button icon varies by role: GitBranch (parent), GitMerge (child), Network (both)
6. Each icon has distinct color and tooltip
7. HierarchyModal filter input is always visible regardless of node count
8. No 44px/56px touch-target mandates remain in agent rules/definitions
9. No buttons enlarged — compact dense controls preserved (max 22px hierarchy button)
