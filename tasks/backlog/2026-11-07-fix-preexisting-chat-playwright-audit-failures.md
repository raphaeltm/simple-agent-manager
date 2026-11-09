# Fix pre-existing project chat Playwright audit failures

## Problem

Four local Playwright audit tests fail on `origin/main` (349c78101), reproduced by building
`main`'s `apps/web/src` and running the specs against `vite preview`:

- `new-chat-profile-picker-audit.spec.ts` › "15 profiles: recent cards, last-used default,
  compact composer" (iPhone SE 375x667): composer slab is 25.8% of the viewport
  (`composerShareOfViewport` received 0.2579, limit 0.25).
- `project-chat-composer-audit.spec.ts` › "restored provisioning session shows staged progress
  without overflow" (iPhone SE and Desktop 1280x800): `expect(locator).toBeVisible()` fails.
- `project-chat-composer-audit.spec.ts` › "mention syntax stays intact in active composer"
  (iPhone SE only): `expect(locator).toBeVisible()` fails.

## Context

Found 2026-11-07 while running the visual audit for per-chat model/effort overrides
(task `2026-11-07-per-chat-model-effort-overrides.md`). Identical results with and without
that branch's changes, so they predate it. CI's `playwright-visual` job runs non-quarantined
audits only on `iPhone 14 (390x844)` (`.github/workflows/ci.yml`), so it runs
`new-chat-profile-picker-audit.spec.ts` but never at iPhone SE 375x667, and
`project-chat-composer-audit.spec.ts` is listed in `apps/web/tests/playwright/visual-audit-quarantine.txt`
and does not run in CI at all. That is why these went unnoticed.

## Acceptance Criteria

- [ ] Each failure is diagnosed: a real UI regression is fixed, or a stale test is updated
      to the current intended UI with a reason
- [ ] All four pass at the listed viewports against a fresh `vite build`
- [ ] `project-chat-composer-audit.spec.ts` is removed from the quarantine list once it passes
- [ ] Decide whether CI should also run the iPhone SE (375x667) and Desktop (1280x800) projects for
      these chat audits, since both failures above only appear at viewports CI does not run

## Merged from `2026-10-21-composer-audit-provisioning-progress-test-fails-on-main.md` (2026-11-09)

That file first reported the "restored provisioning session" failure on `main` `c0fb8edd8`: the page
renders the mocked session as "Running" with a "Reconnecting..." alert and no provisioning block
(`getByText('Installing dependencies (3/4)')` not found). If it is a product regression, the fix
needs a unit test through the real restore path; if the mocks drifted, the spec must drive the data
path the page uses today. Repro: `cd apps/web && npx playwright test
tests/playwright/project-chat-composer-audit.spec.ts -g "restored provisioning" --project="Desktop (1280x800)"`.
