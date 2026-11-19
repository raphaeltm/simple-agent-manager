# Fix stale compute-creation and DigitalOcean Playwright specs

## Problem

Two Playwright specs in `apps/web/tests/playwright/` fail on `main` (checked at
`6ea5ecba1`, the parent of the create-workspace removal PR):

- `compute-creation-browser.spec.ts` (`playwright.compute-creation.config.ts`): every
  `Nodes ...` test fails at both 375x667 and 1280x800, e.g. `Nodes create posts the
  selected native offering and shows API rejection` times out on a click and
  `Nodes reset native selection when provider or location changes` fails
  `expect(locator).toBeDisabled()`.
- `settings-digitalocean-credential-audit.spec.ts`: all five tests fail
  `expect(locator).toBeVisible()`.

Neither spec seems to run in CI, so nothing reports the failures. The Nodes create form
and the credentials settings UI have probably changed since the specs were written
(recent pool work, e.g. #2616).

## Context

Found while removing the `/workspaces/new` screen. The failures are identical before and
after that change.

## Acceptance Criteria

- [ ] Both specs pass locally at mobile and desktop viewports against current `main`
- [ ] Assertions follow the current Nodes create and credential settings UI, and still
      check behavior, not just that elements are present
- [ ] Decide whether CI should run them, and if so wire them into CI so this cannot
      silently go stale again
