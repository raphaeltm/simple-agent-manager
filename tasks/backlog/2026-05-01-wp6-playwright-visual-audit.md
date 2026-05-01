# Playwright Visual Audit for Admin AI Proxy

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
