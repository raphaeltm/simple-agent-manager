# Nested sidebar Playwright audit blocked by the onboarding wizard

## Problem

Four tests in `apps/web/tests/playwright/nested-session-sidebar-audit.spec.ts` (mobile: normal
nesting, deep nesting, stopped ancestors, history hierarchy; desktop: history hierarchy) time out
at 30s: the "Set up SAM" onboarding wizard (`data-testid="onboarding-wizard"`) intercepts the click
on **Open chat list**. The connector-provenance test in the same file passes because it sets
`sam-onboarding-wizard-dismissed-user-test-1` in localStorage first; the others don't.

## Context

Found 2026-11-13 while running the audit for the usage-windows / per-run account branch
(`sam/two-ui-issues-one-rm7pez`). Unrelated to that change.

## Acceptance Criteria

- [ ] Every test in the spec dismisses the onboarding wizard (shared `beforeEach` init script)
- [ ] The spec passes at 375x667 and 1280x800
