# Interactive HTML Artifact Preview MVP

See SAM idea `01KZ6A5AX8YB1ZXXRT53VNE5ZD` for the authoritative Phase 2 implementation brief.

## Checklist

- [x] Generated preview hostname, DNS, routes, vars, and signing secret support upgrades and clean installs.
- [x] Signed path-prefix minting is project/file/version/expiry scoped and uses constant-time HMAC validation.
- [x] Preview host dispatch runs before session auth and applies strict CSP/security headers to all responses without cookies.
- [x] Explicit project-chat HTML action confirms risk, runs an `allow-scripts`-only iframe, warns, stops/resets, and never autoruns.
- [ ] Miniflare, unit, UI, browser isolation, mobile/desktop visual, and CORS/trusted-origin invariant tests pass.
- [x] Security architecture, self-hosting, and configuration reference docs are updated.
- [ ] Specialist reviews, staging verification, CI, merge, and production deployment complete.

## Acceptance criteria

- [ ] Interactive single-file HTML works after an explicit click on `preview.<domain>` while cookies, network, forms, popups/downloads, and top navigation remain blocked.
- [ ] Direct-open remains CSP-sandboxed with opaque origin; invalid/expired/tampered/stale links fail closed with the same strict headers.
- [ ] Tier-0 inert rendering is unchanged; preview remains outside credentialed CORS and BetterAuth trusted origins; `allow-same-origin` is never used.
- [ ] No manual GitHub secret prerequisite is added; hostname stays single-level and supports `PREVIEW_BASE_DOMAIN`.

## References

- `.claude/rules/13-staging-verification.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/48-stale-while-revalidate-ui.md`
