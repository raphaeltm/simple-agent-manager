# Theme switcher — close Playwright audit coverage gaps

> **Reconciliation 2026-10-05:** Both specs this file extends are quarantined (`apps/web/tests/playwright/visual-audit-quarantine.txt:105-106`, since 2026-08-25), so new coverage there will not run in CI until `2026-07-17-stale-playwright-audit-specs.md` repairs them.

**Date:** 2026-06-07
**Origin:** Late-arriving task-completion-validator (WARN, 2 MEDIUM) on the
merged three-way theme switcher (PR #1246, task
`01KTGR36MXMN0NV0H5VED4ZCGP`).

## Problem Statement

PR #1246 shipped the discoverable three-way theme switcher (Dark/Light/System).
The validator returned WARN with no CRITICAL/HIGH findings, but flagged two
MEDIUM **test-coverage completeness** gaps. Both are additive, test-only, and
carry low functional risk — the underlying behavior is already covered by
passing unit tests (2,248/2,248) and the feature was verified end-to-end on
staging. They were deferred to backlog (rule 25 permits MEDIUM deferral with
justification) rather than blocking the already-merged, already-deployed PR.

## Findings to Address

1. **Project chat surface not audited.** `theme-switcher-audit.spec.ts`
   navigates only to `/dashboard` for both the desktop sidebar and mobile
   drawer tests. The task spec listed project chat as a required surface, but no
   Playwright test exercises the ThemeSwitcher on
   `/projects/:id/chat/:sessionId`.
   - Risk: an AppShell sidebar-footer layout/overflow difference on the chat
     page vs. the dashboard would go uncaught.

2. **`theme-foundation-audit.spec.ts` not extended for `system`.**
   `audit-helpers.ts` `seedTheme`/`expectTheme` were correctly extended to
   accept `'system'` (with a deterministic `matchMedia` override), but the
   foundation audit spec still only calls `auditTheme(page, 'dark', ...)` and
   `auditTheme(page, 'light', ...)`. No Playwright test seeds `system` and
   verifies the pre-paint script resolves it correctly on the chat URL.
   - Risk: low — the pre-paint path is `applyThemeAttribute(readStoredTheme())`,
     whose `resolveEffectiveTheme` is fully unit-tested.

## Implementation Checklist

- [ ] Add a test group to `apps/web/tests/playwright/theme-switcher-audit.spec.ts`
      that navigates to `/projects/proj-test-1/chat/session-1` (already mocked by
      `setupApiMocks`), asserts the desktop sidebar ThemeSwitcher group is
      visible, and asserts no horizontal overflow at desktop (1280x800).
- [ ] Add the mobile-drawer ThemeSwitcher assertion on the chat surface at
      mobile (375x667), reusing `assertThemeButtonsNotClipped`.
- [ ] Extend `apps/web/tests/playwright/theme-foundation-audit.spec.ts` with two
      `auditTheme(page, 'system', ...)` calls — one seeded OS-dark, one OS-light —
      mirroring the existing dark/light pattern (`seedTheme` already supports the
      `prefersDark` parameter).
- [ ] Run the audits locally; confirm no overflow and screenshots are clean.

## Acceptance Criteria

- Playwright coverage exercises the ThemeSwitcher on the project chat surface at
  both viewports, asserting visibility and no overflow.
- `theme-foundation-audit.spec.ts` exercises the `system` theme (OS-dark and
  OS-light) and verifies correct pre-paint resolution.
- All quality gates green.

## References

- Validator report: task `a4d370d95b6ce1668`
- Shipped switcher: `apps/web/src/components/ThemeSwitcher.tsx`
- Helpers: `apps/web/tests/playwright/audit-helpers.ts`
- `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/25-review-merge-gate.md`
