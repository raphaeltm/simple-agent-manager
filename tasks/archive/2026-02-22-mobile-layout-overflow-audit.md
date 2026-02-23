# Mobile Layout Overflow Audit

**Created**: 2026-02-22
**Priority**: High
**Effort**: Medium
**Tags**: `ui-change`

## Problem

On mobile viewports, the project list and workspace cards have horizontal overflow issues. Buttons on the right side of workspace/project rows are pushed off-screen, requiring horizontal scrolling to access. The content is small enough that it should fit comfortably on a phone screen without any horizontal scroll.

## Goal

Audit and fix all mobile overflow issues on the dashboard, project list, and workspace views so everything fits within the viewport width with no horizontal scrolling.

## Scope

- Audit all dashboard/project/workspace list views at common mobile widths (320px, 375px, 414px)
- Fix horizontal overflow on project cards and workspace rows — buttons, status badges, and actions must be visible without horizontal scrolling
- Consider responsive layouts: stack elements vertically, use icon-only buttons, or truncate text on narrow screens
- Add Playwright tests at mobile viewport sizes with mock data to verify no horizontal overflow occurs on key pages (dashboard, project detail, workspace list)
- Test with varying content lengths (long project names, long workspace names, multiple action buttons)

## Acceptance Criteria

- No horizontal scrollbar appears on any primary view at 320px viewport width
- All action buttons are visible and tappable without horizontal scrolling
- Playwright tests cover the main views at mobile breakpoints and assert no overflow
