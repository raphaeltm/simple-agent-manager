# Fix stale scaling-settings Playwright audit expectations

## Problem

`apps/web/tests/playwright/scaling-settings-audit.spec.ts` has 4 failing assertions (2 tests × viewports) in the "removed duplicate sections are absent, renamed section present" case: `locator('text=Workspace Idle Timeout')` expects the renamed section heading to be visible, but it is not rendered under the spec's mock-data setup.

## Context

Discovered during the 2026-08-11 AI-slop debt burn-down PR's Phase 4 validation. Verified **pre-existing**: the identical 4 failures reproduce byte-for-byte on `origin/main` (`311758585`) in a clean worktree with freshly built packages (44 passed / 4 failed on both trees). The heading string exists at `apps/web/src/pages/ProjectSettings.tsx:399`, so either the audit spec's route/mock setup no longer renders that section (conditional rendering the mocks don't satisfy) or the spec's expectation drifted from a later settings-page restructure. These Playwright audit specs are not part of CI's blocking suite, which is why this never blocked a merge.

## Acceptance criteria

- [ ] Determine whether the "Workspace Idle Timeout" section should render under the audit spec's mock data (fix mocks) or the expectation is stale (fix/remove the assertion)
- [ ] `npx playwright test tests/playwright/scaling-settings-audit.spec.ts` passes at both viewports (48/48)
- [ ] If the section's conditional rendering hides real user-facing behavior regressions, file/fix separately
