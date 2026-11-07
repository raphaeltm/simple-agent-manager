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
that branch's changes, so they predate it. These audits do not run in CI, which is why
they went unnoticed.

## Acceptance Criteria

- [ ] Each failure is diagnosed: a real UI regression is fixed, or a stale test is updated
      to the current intended UI with a reason
- [ ] All four pass at the listed viewports against a fresh `vite build`
- [ ] Consider whether these audits should run in CI so drift is caught
