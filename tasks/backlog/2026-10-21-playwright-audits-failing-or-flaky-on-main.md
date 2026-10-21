# Playwright audits failing or flaky on main

## Problem

Running the Playwright specs that open the project chat screens against `main` (c0fb8edd8) on 2026-10-21 shows three problems unrelated to the change being tested. Each was reproduced with `main`'s `apps/web` checked out.

1. `lazy-route-chunks-audit.spec.ts` › "the landing page downloads no heavy vendor chunk": the landing page fetches **103** scripts against a budget of `< 40`. The heavy-chunk assertion passes; the script-count budget does not. Either the chunk graph has fragmented (the build warns `advancedChunks option is deprecated, please use codeSplitting instead`) or the budget is stale.
2. `lazy-route-chunks-audit.spec.ts` › "a 404ing route chunk is retried, then recovered by a single reload" is **flaky**: 3 of 8 runs pass on `main` (`--repeat-each=4` at 375×667 and 1280×800). Logging shows that when it passes, the route intercepts `Nodes-*.js` at about 280 ms. When it fails, `page.route` sees no request, which matches the spec's own note that service-worker-initiated fetches bypass `page.route` once `src/sw.ts` controls the page. It is a race between the service worker taking control and the lazy import.
3. `marketing-shots-context.spec.ts` › `sam-chat-tool-stream`: `getByText('sam-mcp/get_instructions')` is not found, so the tool-row rendering or the fixture no longer matches.

The `portal-overlay-audit` "Shared Tooltip portal renders with blurred surface" failure is already known (noted in PR #2389) and is left out of this task.

## Context

Found while validating the new-chat profile picker (branch `sam/new-chat-profile-picker`). None of these specs exercise that change, and each fails on `main` without it.

## Acceptance criteria

- [ ] Landing script budget: decide whether the chunk graph regressed (fix the chunking) or the budget is stale (re-baseline with a measured number), then make the assertion pass.
- [ ] Stale-chunk test: make it deterministic. For example, block service workers for this test (`test.use({ serviceWorkers: 'block' })`) if the recovery ladder doesn't need one, or intercept at a layer the service worker cannot bypass. Then verify 20/20 passes.
- [ ] `sam-chat-tool-stream`: update the fixture or the assertion to match how tool rows render today, and re-check the marketing image.
