# Redesign Worktree Selector

**Created**: 2026-02-23
**Priority**: Medium
**Classification**: `ui-change`, `cross-component-change`

## Context

The worktree selector needs three improvements:
1. **Design**: The current dropdown/popover approach feels like a "tab" — needs better UX
2. **Auto-refresh**: Worktrees only refresh on initial load and after explicit create/remove — no polling
3. **Arbitrary limit**: Hardcoded default of 5 worktrees max, configured via `MAX_WORKTREES_PER_WORKSPACE`

## Current Implementation

### Frontend
- **Component**: `apps/web/src/components/WorktreeSelector.tsx` (1-445 lines)
  - Button shows `"Worktree: {activeLabel}"` (line 152)
  - Opens popover with worktree list on click
  - Has create/delete functionality built in

### Refresh Logic
- **File**: `apps/web/src/pages/Workspace.tsx` (lines 420-435)
  - `refreshWorktrees()` called once on mount via `useEffect`
  - Called again after create/remove actions
  - **No polling** — contrast with git status which polls every 30 seconds

### Limit
- **File**: `packages/vm-agent/internal/config/config.go:277`
  ```go
  MaxWorktreesPerWorkspace: getEnvInt("MAX_WORKTREES_PER_WORKSPACE", 5),
  ```
- **Enforcement**: `packages/vm-agent/internal/server/worktrees.go:247-249`
  ```go
  if len(worktrees) >= s.config.MaxWorktreesPerWorkspace { ... }
  ```

### Backend Caching
- `worktrees.go:95-109` — 5-second cache TTL (`WorktreeCacheTTL`)

## Plan

1. Increase the default worktree limit to a reasonable number (e.g., 20)
2. Add polling for worktree list (similar to git status — every 30 seconds)
3. Redesign the selector to be more integrated (not a floating popover) — consider inline display in the sidebar or a more subtle header element

## Detailed Tasklist

- [ ] Read `apps/web/src/components/WorktreeSelector.tsx` to understand current design
- [ ] Read `apps/web/src/pages/Workspace.tsx` worktree-related code (lines 420-435, 770-790)
- [ ] Increase default `MAX_WORKTREES_PER_WORKSPACE` from 5 to 20 in `packages/vm-agent/internal/config/config.go:277`
- [ ] Add worktree polling interval (30 seconds, similar to git status) in `Workspace.tsx`
- [ ] Redesign WorktreeSelector: make it a clean inline dropdown instead of a popover panel — simpler, less "tab-like"
- [ ] Show branch name and dirty status compactly
- [ ] Ensure the worktree list updates in real-time (polling + after actions)
- [ ] Update any tests that reference the old limit
- [ ] Run Go tests: `cd packages/vm-agent && go test ./...`
- [ ] Run web build: `pnpm --filter @simple-agent-manager/web build`
- [ ] Run typecheck: `pnpm typecheck`

## Files to Modify

| File | Change |
|------|--------|
| `packages/vm-agent/internal/config/config.go` | Increase default max worktrees to 20 |
| `apps/web/src/components/WorktreeSelector.tsx` | Redesign to inline dropdown |
| `apps/web/src/pages/Workspace.tsx` | Add worktree polling |
