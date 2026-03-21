# Ideas UI/UX Audit with Playwright Mobile Screenshots

## Problem Statement

Audit all ideas/tasks-related UI pages by rendering them with mock data on mobile viewports using Playwright. Evaluate rendering quality, text overflow handling, error states, empty states, and overall UX across various content scenarios.

## Research Findings

### Pages to Audit

1. **IdeasPage** (`apps/web/src/pages/IdeasPage.tsx`) — Read-only timeline view grouped by status (exploring/ready/executing/done/parked). Search + filter bar, collapsible groups, IdeaCard buttons with title/description/session count/time-ago.

2. **TaskDetail** (`apps/web/src/pages/TaskDetail.tsx`) — Single task detail with inline title editing, status transitions, description, output section (TTS), error display, activity log, sidebar with metadata/dependencies/actions. Uses `md:grid-cols-[minmax(0,1fr)_300px]` grid — sidebar stacks below on mobile.

3. **Dashboard** (`apps/web/src/pages/Dashboard.tsx`) — Active tasks grid with `ActiveTaskCard` components, plus projects section. Uses responsive grid `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`.

4. **ActiveTaskCard** (`apps/web/src/components/ActiveTaskCard.tsx`) — Card showing status badge, active/idle dot, title (truncated), project name, execution step, timestamps.

5. **TaskSubmitForm** (`apps/web/src/components/task/TaskSubmitForm.tsx`) — Bottom-pinned form in ProjectChat with title input, SplitButton (Run Now / Save to Backlog), advanced options toggle.

6. **ProjectInfoPanel** — Slide-out panel showing recent tasks with status badges.

### Test Scenarios per Page

- **Empty state** — no data
- **Normal data** — typical content
- **Long text** — very long titles (200+ chars), long descriptions, long error messages
- **Many items** — 20+ ideas in various statuses
- **Error states** — API errors, task error messages, validation errors
- **Mixed statuses** — all status types represented
- **Edge cases** — single-character titles, special characters, missing optional fields

### Technical Approach

- Use Playwright with mobile viewport (375x667 iPhone SE, 390x844 iPhone 14)
- Intercept API requests via `page.route()` to inject mock data
- Mock authentication to bypass login
- Take screenshots for each scenario
- Evaluate rendering quality programmatically and visually

## Implementation Checklist

- [x] Set up Playwright config and test infrastructure
- [x] Create comprehensive mock data factory for all scenarios
- [x] Write IdeasPage audit tests (8 tests: empty, normal, long text, many items, search filter, no results, status filter, collapsed groups)
- [x] Write TaskDetail audit tests (7 tests: normal, error with long message, completed with output, long title, no description, blocked, many activity events)
- [x] Write Dashboard/ActiveTaskCard audit tests (4 tests: empty, active tasks, many tasks, long names)
- [x] Write TaskSubmitForm audit tests (3 tests: default state, advanced options, long input)
- [x] Run all tests on mobile viewport and capture screenshots (22/22 pass)
- [x] Evaluate screenshots and document findings
- [x] Fix rendering issues: IdeasPage card overflow (added overflow-hidden), Breadcrumb mobile wrapping (added flex-wrap, truncation)
- [x] Re-run and confirm fixes (22/22 pass, screenshots verified)

## Acceptance Criteria

- [x] Every ideas/tasks page rendered on mobile (375px) with screenshots — 22 screenshots across IdeasPage, TaskDetail, Dashboard, TaskSubmitForm
- [x] Long text content does not overflow or break layout — fixed IdeasPage overflow-hidden, Breadcrumb truncation
- [x] Empty states display correctly with helpful messages — verified lightbulb icon + guidance text
- [x] Error states are clearly visible and don't break layout — red-bordered error card with long error message wraps correctly
- [x] All interactive elements are at least 44px touch targets — group headers have min-h-[44px], cards have min-h-[56px]
- [x] Text is readable (no truncation hiding critical info without ellipsis) — line-clamp-1 with ellipsis on cards, full text visible on detail pages
- [x] Evaluation report with findings and fixes documented — see PR description
