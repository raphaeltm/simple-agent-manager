# Complete Smoke Test Auth Fix

## Problem

The smoke test authentication system was broken because:
1. **Raw DB inserts bypassed BetterAuth's schema mapping** — direct `db.insert(schema.sessions)` produced sessions that `getSession()` couldn't find because BetterAuth uses `usePlural` and field transforms internally.
2. **Cookie prefix mismatch** — BetterAuth prefixes cookie names with `__Secure-` when `baseURL` starts with `https://`, but the token-login endpoint used the unprefixed name `better-auth.session_token`.

A previous agent fixed both issues on branch `fix/smoke-test-auth-session` (4 commits) and confirmed all 11 smoke tests pass on staging, but the session ended before a PR was created.

## Research Findings

- **Branch**: `fix/smoke-test-auth-session` — 4 commits, 3 files changed
- **Key change 1**: `smoke-test-tokens.ts` — replaced raw `db.insert(schema.sessions)` with `ctx.internalAdapter.createSession()` from BetterAuth
- **Key change 2**: `smoke-test-tokens.ts` — cookie name now conditionally uses `__Secure-` prefix based on `isSecure`
- **Key change 3**: `tests/smoke/helpers/auth.ts` — regex updated to match both prefixed and unprefixed cookie names
- **Deleted**: `tests/smoke/auth-debug.spec.ts` — temporary debug test no longer needed
- **Branch is 3 commits behind main** — no conflicting changes on main (files not touched)
- **No existing PR** on this branch

## Implementation Checklist

- [ ] Rebase `fix/smoke-test-auth-session` onto current `main`
- [ ] Verify build passes (`pnpm typecheck && pnpm lint && pnpm test`)
- [ ] Clean up stale comment about "direct DB insert" in JSDoc (line 219-222)
- [ ] Create PR with proper description
- [ ] Deploy to staging and verify smoke tests pass
- [ ] Merge

## Acceptance Criteria

- [ ] All smoke tests pass on staging
- [ ] BetterAuth session creation uses internal adapter (not raw DB insert)
- [ ] Cookie prefix matches BetterAuth expectations (`__Secure-` for HTTPS)
- [ ] Smoke test auth helper handles both prefixed and unprefixed cookie names
- [ ] Debug test file is removed
