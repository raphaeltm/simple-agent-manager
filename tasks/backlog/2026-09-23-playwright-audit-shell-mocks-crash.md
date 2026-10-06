# Playwright audit specs crash the app shell when `/api/credentials` is unmocked

## Problem

`setupAuditRoutes` answers every unmatched `/api/**` request with `{}`. The app shell now
fetches `/api/credentials` (and `/api/github/installations`) on every authenticated page and
calls an array method on the result, so any audit spec that does not explicitly mock those
endpoints as `[]` renders the "Something went wrong" crash screen (`e.some is not a function`)
instead of the surface under test. `admin-trials-audit.spec.ts` fails this way today on `main`
(4/4 failing at Desktop 1280x800 on 2026-09-23); it only stays invisible because CI runs a
selected subset of audit specs.

Separately, the first-run cloud onboarding wizard overlays every page for a mocked user without
credentials, so specs that do not seed `sam-onboarding-wizard-dismissed-<userId>` in
localStorage screenshot the wizard, not the page (rule 62 incident class).

## Context

Discovered while adding `admin-storage-audit.spec.ts` in PR #2135, which works around both by
mocking `/api/credentials*`, `/api/github/installations`, `/api/workspaces`,
`/api/provider-catalog*` and dismissing the wizard via `addInitScript`.

## Acceptance Criteria

- [ ] `setupAuditRoutes` (or a shared `setupAppShellMocks` helper) provides array-shaped defaults
      for the shell fetches and dismisses the onboarding wizard by default
- [ ] `admin-trials-audit.spec.ts` and every other admin audit spec pass locally at
      375x667 and 1280x800 without per-spec shell mocks
- [ ] The full local audit corpus (`playwright.audit.config.ts`) is run once and any other
      spec broken by the same cause is fixed
- [ ] The default `{}` fallback in `setupAuditRoutes` fails loudly (or logs) for unmatched
      `/api/**` paths so the next new shell fetch is noticed
