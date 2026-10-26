# Fix Playwright Desktop Test Infrastructure

> **Reconciliation 2026-10-26:** #2389 (`0a0276390`) deleted `triggers-ui-audit.spec.ts` when
> Triggers became the Automation page (`automation-audit.spec.ts`, which runs at 1280x800), so
> that criterion is moot. `profiles-ui-audit.spec.ts` still skips its desktop tests (`:310-312`)
> and is quarantined (`visual-audit-quarantine.txt:70`); the root cause is still unrecorded.

## Problem

Desktop-viewport Playwright visual audit tests crash with an error boundary exception before any page data loads. The error is "Cannot read properties of undefined (reading 'length')" and occurs in the desktop layout rendering path, not in any specific component being tested.

This affects multiple test files:
- `apps/web/tests/playwright/profiles-ui-audit.spec.ts` (desktop tests skipped)
- `apps/web/tests/playwright/triggers-ui-audit.spec.ts` (desktop tests also affected)
- Likely any other Playwright visual audit running at desktop viewport (1280x800)

## Context

Discovered during the profiles mobile layout fix (PR on branch `sam/try-mock-profiles-page-01kqh7`). Mobile tests (375x667) work correctly with mocked API data, but desktop tests crash immediately regardless of mock data quality.

## Acceptance Criteria

- [ ] Desktop Playwright visual audits run without error boundary crashes
- [ ] `profiles-ui-audit.spec.ts` desktop tests pass
- [ ] `triggers-ui-audit.spec.ts` desktop tests pass
- [ ] Root cause identified and documented
