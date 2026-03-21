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

- [ ] Set up Playwright config and test infrastructure
- [ ] Create comprehensive mock data factory for all scenarios
- [ ] Write IdeasPage audit tests (empty, normal, long text, many items, filtered)
- [ ] Write TaskDetail audit tests (normal, long text, error state, with output, with dependencies)
- [ ] Write Dashboard/ActiveTaskCard audit tests (empty, normal, many tasks, long titles)
- [ ] Write TaskSubmitForm audit tests (default, advanced options, error state, submitting state)
- [ ] Run all tests on mobile viewport and capture screenshots
- [ ] Evaluate screenshots and document findings
- [ ] Fix any rendering issues found
- [ ] Re-run and confirm fixes

## Acceptance Criteria

- [ ] Every ideas/tasks page rendered on mobile (375px) with screenshots
- [ ] Long text content does not overflow or break layout
- [ ] Empty states display correctly with helpful messages
- [ ] Error states are clearly visible and don't break layout
- [ ] All interactive elements are at least 44px touch targets
- [ ] Text is readable (no truncation hiding critical info without ellipsis)
- [ ] Evaluation report with findings and fixes documented
