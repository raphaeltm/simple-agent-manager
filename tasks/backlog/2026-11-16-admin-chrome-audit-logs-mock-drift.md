# Admin chrome theme audit: Logs and Errors pages crash under the spec's mocks

## Problem

`apps/web/tests/playwright/admin-chrome-theme-audit.spec.ts` ("logs and errors dark/light with
many rows" on mobile, "logs/errors dark and light" on desktop) fails locally: `/admin/logs` and
`/admin/errors` render the error boundary ("Something went wrong") with the browser console error
`TypeError: c is not iterable`. An endpoint the pages call is not mocked and falls through to the
spec's `{}` default, where the page expects an array.

## Context

Found 2026-11-16 while running the Insights slice H visual audit (branch
`sam/build-insights-slice-h-szwhn2`). The Costs cases in the same spec pass, so the failure is in
the Logs/Errors mocks, not in the shared admin chrome. CI's "Playwright Visual Tests" job passed on
PR #2775, so the job may not run this spec on every PR; check that too.

## Acceptance Criteria

- [ ] Identify the unmocked endpoint(s) the Logs and Errors pages call
- [ ] Mock them with realistic shapes; both cases pass at 375 and 1280
- [ ] Confirm whether CI runs this spec, and if not, why
