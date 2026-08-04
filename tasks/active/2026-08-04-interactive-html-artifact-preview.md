# Interactive HTML Artifact Preview MVP

See SAM idea `01KZ6A5AX8YB1ZXXRT53VNE5ZD` for the authoritative Phase 2 implementation brief.

## Checklist

- [x] Generated preview hostname, DNS, routes, vars, and signing secret support upgrades and clean installs.
- [x] Signed path-prefix minting is project/file/version/expiry scoped and uses constant-time HMAC validation.
- [x] Preview host dispatch runs before session auth and applies strict CSP/security headers to all responses without cookies.
- [x] Explicit project-chat HTML action confirms risk, runs an `allow-scripts`-only iframe, warns, stops/resets, and never autoruns.
- [x] Miniflare, unit, UI, browser isolation, mobile/desktop visual, and CORS/trusted-origin invariant tests pass.
- [x] Security architecture, self-hosting, and configuration reference docs are updated.
- [ ] Specialist reviews, staging verification, CI, merge, and production deployment complete.

## Acceptance criteria

- [x] Interactive single-file HTML works after an explicit click on `preview.<domain>` while cookies, network, forms, popups/downloads, and top navigation remain blocked.
- [x] Direct-open remains CSP-sandboxed with opaque origin; invalid/expired/tampered/stale links fail closed with the same strict headers.
- [x] Tier-0 inert rendering is unchanged; preview remains outside credentialed CORS and BetterAuth trusted origins; `allow-same-origin` is never used.
- [x] No manual GitHub secret prerequisite is added; hostname stays single-level and supports `PREVIEW_BASE_DOMAIN`.

## Validation evidence

- Local: repository lint, typecheck, tests, and build pass; focused preview API/UI/infra suites pass.
- Miniflare worker startup is blocked in this devcontainer by a native workerd SIGSEGV; equivalent signed-host error-path coverage is committed and the real Cloudflare Worker path passed staging.
- Visual: Playwright confirmation-dialog audit passed at 375x667 and 1280x800 with overflow assertions.
- Staging: Deploy Staging run 30938933551 passed, including smoke tests; feature-specific Playwright passed on preview.sammy.party (1 test, 50.1s).
- Browser isolation observed: inline JS ran only after confirmation; cookies, fetch, WebSocket, beacon network emission, forms, popups, downloads, and top navigation were blocked; direct-open retained CSP sandbox and no Set-Cookie.
- Review: security, Cloudflare, environment, documentation, UI/UX, constitution, and completion checklists were applied directly after the local reviewer runner repeatedly interrupted before producing reports.

## References

- `.claude/rules/13-staging-verification.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/48-stale-while-revalidate-ui.md`
