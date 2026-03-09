# CORS Origin Fallthrough Post-Mortem

**Date**: 2026-03-09

## What Broke

The CORS middleware in `apps/api/src/index.ts` unconditionally reflected the requesting `Origin` header as `Access-Control-Allow-Origin` for ALL origins, including unknown/malicious ones. Combined with `credentials: true`, this meant any website could make credentialed cross-origin requests to session-authenticated API routes.

## Root Cause

The `origin` callback in the Hono `cors()` middleware had a fallthrough case that returned the origin unchanged:

```typescript
origin: (origin, c) => {
  if (origin?.includes('localhost')) return origin;
  if (origin?.includes(baseDomain)) return origin;
  return origin; // BUG: reflects ANY origin
},
```

The final `return origin` should have been `return null` to reject unrecognized origins.

Additionally, the `includes()` check for `baseDomain` was a substring match, not a proper subdomain check. An origin like `https://notexample.com` would pass if `baseDomain` was `example.com`.

## Timeline

- **Introduced**: Initial CORS middleware setup (early in project history)
- **Discovered**: 2026-03-07, during security review of the MCP server feature
- **Fixed**: 2026-03-09

## Why It Was Not Caught

1. **No negative CORS test**: Existing tests only verified that allowed origins got correct headers. No test verified that unknown origins were *rejected*.
2. **Source-contract test**: The existing `cors-config.test.ts` was a `readFileSync` + `toContain()` test that checked for header presence in source code, not behavioral correctness.
3. **No security review checklist for CORS**: The CORS configuration was not flagged during reviews because there was no checklist item requiring verification that unknown origins are blocked.

## Class of Bug

**Security-sensitive default-allow configuration**. When a security middleware has a fallthrough/default case, it must default to *deny*, not *allow*. This is the same class as firewall rules that default-allow unmatched traffic.

## Process Fix

Added a security review checklist item to `.claude/rules/06-technical-patterns.md` requiring CORS origin callbacks to default-deny unknown origins and mandating negative tests (unknown origin rejection) alongside positive tests (known origin acceptance).
