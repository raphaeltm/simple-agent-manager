# UI Audit Follow-Up: Deferred Items

## Problem Statement

During the ideas UI/UX audit (task `2026-03-21-ideas-ui-ux-audit.md`), several items were identified but deferred to keep scope focused. These should be addressed in a follow-up.

## Research Findings

### ProjectInfoPanel (`apps/web/src/components/project/ProjectInfoPanel.tsx`)
- Slide-out dialog panel (fixed, right-aligned, `w-[min(400px,90vw)]`)
- Fetches workspaces via `listWorkspaces()` and tasks via `listProjectTasks()`
- Displays active/stopped workspaces and recent tasks (max 5 each)
- Has close button (`p-1`), workspace items (`py-2 px-3`), task link items (`py-2 px-3`)
- Touch targets on items rely on padding, no explicit `min-h-*` classes
- Needs mock routes: `/api/workspaces*` (already in setupApiMocks), `/api/projects/:id/tasks` (already handled)
- Panel is opened from project page header — need to navigate to a project page and trigger the info button

### Playwright Config (`apps/web/playwright.config.ts`)
- Single viewport: `{ width: 375, height: 667 }` (iPhone SE)
- Uses Chromium with `isMobile: true`, `hasTouch: true`, `deviceScaleFactor: 2`
- Need to add a second Playwright project for 390x844 (iPhone 14)

### Existing Test Patterns (`apps/web/tests/playwright/ideas-ui-audit.spec.ts`)
- Uses `setupApiMocks()` with a single catch-all `page.route('**/api/**')` handler
- Mock data factories (`makeTask`, `makeDetailTask`)
- `takeScreenshot()` helper for manual screenshots
- 22 existing tests across 4 describe blocks

### Touch Target Classes
- IdeasPage cards: `min-h-[56px]`
- IdeasPage group headers: `min-h-[44px]`
- UI Button md: `min-h-11` (44px)
- ProjectInfoPanel items: No explicit min-height — good candidate for bounding box assertion

## Implementation Checklist

- [ ] Update Playwright config to add 390x844 viewport as second project
- [ ] Add ProjectInfoPanel test describe block with mock workspace data
  - [ ] Test: empty state (no workspaces, no tasks)
  - [ ] Test: normal data (mix of active/stopped workspaces + recent tasks)
  - [ ] Test: many items with long titles (overflow handling)
- [ ] Add bounding box assertion for touch target size on IdeasPage card elements
- [ ] Run tests and verify all pass

## Acceptance Criteria

- [ ] ProjectInfoPanel tested on mobile with mock data (empty, normal, many tasks)
- [ ] 390x844 viewport added as second Playwright project
- [ ] At least one bounding box assertion for touch target size
