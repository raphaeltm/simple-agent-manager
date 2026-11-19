# lazy-route-chunks-audit.spec.ts fails on main

## Problem

`apps/web/tests/playwright/lazy-route-chunks-audit.spec.ts` has four failing cases on
`origin/main` (1df45ee7e), reproduced locally on 2026-11-05 against a fresh `pnpm build`:

- `settings renders without overflow` (mobile and desktop): `/settings/cloud-provider`
  renders the global ErrorBoundary ("Something went wrong") under the spec's mocks.
- `the landing page downloads no heavy vendor chunk`: 112 scripts fetched, budget `< 40`.
- `a 404ing route chunk is retried, then recovered by a single reload`: the failing
  route chunk is never requested.

## Context

Found while running the app-wide RouteFallback audit for the cold chat load change
(branch `sam/review-fix-cold-chat-b6qqyz`). The same four cases fail identically with
and without that branch, so they are not caused by it.

## Acceptance Criteria

- [ ] Decide per case whether the app or the spec drifted (mock coverage for the
      cloud-provider settings page, the eager-script budget, the stale-chunk fixture)
- [ ] Fix the app or update the spec so all four pass
- [ ] Note whether this spec runs in CI; if not, say why the budget is not enforced
