# Playwright Visual Audit for Admin AI Proxy

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** `apps/web/tests/playwright/admin-ai-proxy-audit.spec.ts` exists (added in #861,
>   `62cb6be5b`). It mocks the config with low-cost, standard and premium models (:36-44), runs
>   at 375px and 1280px (:84, :149), asserts no horizontal overflow, and its default fixture
>   mixes available and unavailable models (the partial-availability case).
> - **Still open:**
>   - Assert the optgroup labels, which now read "Low Cost", "Standard" and "Premium"
>     (`TIER_LABELS`, `apps/web/src/pages/AdminAIProxy.tsx:32-36`, rendered at :250).
>   - Assert the cost strings for paid models (`AdminAIProxy.tsx:258-259, 334-337`).
>   - Error state: today it is a mobile-only screenshot with no assertion (spec :128-141). Add an
>     assertion and a desktop case.
>   - Empty state (`models: []`) is not tested.
>   - The spec is quarantined (`apps/web/tests/playwright/visual-audit-quarantine.txt:14`), so it
>     does not run in CI.
>   - Caution: the spec answers every other `/api/**` call with `{}` (:66-68). That probably
>     triggers the app-shell crash described in
>     `tasks/backlog/2026-09-23-playwright-audit-shell-mocks-crash.md`, so the existing overflow
>     checks may be measuring the crash screen rather than this page.

## Problem

PR #861 (WP6 Model Catalog Expansion) added substantial new UI surface to `AdminAIProxy.tsx` — tier badges, optgroup-based dropdown, "Available Models" catalog card with cost display, and Unified Billing status indicators — but no Playwright visual audit spec was created. This violates Rule 17.

Discovered by the task-completion-validator after PR merge.

## Acceptance Criteria

- [ ] `apps/web/tests/playwright/admin-ai-proxy-audit.spec.ts` exists
- [ ] Mocks `/api/admin/ai-proxy/config` with data covering all tiers (free/standard/premium)
- [ ] Tests at 375px mobile and 1280px desktop viewports
- [ ] Asserts no horizontal overflow (`scrollWidth <= innerWidth`)
- [ ] Verifies `optgroup` labels ("Free Tier", "Standard", "Premium") render
- [ ] Verifies cost strings appear for non-free models
- [ ] Tests partial availability scenario (some models disabled)
- [ ] Tests empty/error state
