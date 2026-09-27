# `PUT /api/setup/config` echoes plaintext platform secrets in its JSON response

**Severity**: Medium
**Status**: Backlog
**Discovered**: 2026-08-18, by the `security-auditor` review of PR "cache the auth preamble
platform config per isolate". Pre-existing; **not** introduced by that change.

## Problem

`apps/api/src/routes/setup.ts` returns the full `ResolvedPlatformConfig` in its response body:

```ts
return c.json({ ..., config: resolved });
```

`ResolvedPlatformConfig` carries plaintext `.value` fields for every platform secret — GitHub App
private key, GitHub/Google/GitLab OAuth client secrets, and the GitHub webhook secret. The
endpoint is gated by `assertSetupOpen` plus the `SETUP_TOKEN`, so this is not an unauthenticated
leak, but it means those secrets are written into any proxy log, browser devtools history, or HAR
capture taken during first-run setup.

Contrast with the admin surface: `getPlatformConfigStatus` / `integrationStatus` (behind
`GET`/`PUT /admin/platform-config`) deliberately return only booleans and source labels, never
`.value`. The setup route is the outlier.

## Context

Found while auditing the new per-isolate platform-config cache. The auditor noted the two
interact: the setup endpoint can now also echo a *stale* secret back to the admin who just
changed it, if a concurrent slow read clobbers the cache. That specific race was fixed in the
cache PR (generation compare-and-set), so this is left as the standalone response-shape concern.

## Acceptance criteria

- [ ] `PUT /api/setup/config` no longer returns plaintext secret `.value` fields
- [ ] It returns a status/source projection equivalent to `getPlatformConfigStatus` instead
- [ ] The setup wizard UI still renders correctly against the narrowed response (check
      `apps/web` setup flow for any consumer reading `config.*.value`)
- [ ] A regression test asserts no known secret value appears anywhere in the response body
- [ ] Verify no other route serializes `ResolvedPlatformConfig` wholesale

## References

- `apps/api/src/routes/setup.ts`
- `apps/api/src/services/platform-config.ts` (`getPlatformConfigStatus`, `integrationStatus`)
- `apps/www/src/content/docs/docs/architecture/security.md`
