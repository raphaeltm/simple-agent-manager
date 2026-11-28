# Admit only the exact local app origin in browser-write guards

## Problem

Late CodeRabbit finding on merged #2865 (r4611856585). With a local `BASE_DOMAIN`
(`localhost:8787`), `isAppOrigin` in `apps/api/src/lib/browser-write-origin.ts` accepted any
`http://localhost:*` or `http://127.0.0.1:*` origin as the app. Ports do not separate sites, so
Fetch Metadata calls another local app (for example on `:3000`) same-site, and only the origin
check kept it out. Both guards share `isAppOrigin`: `requireTrustedWriteOrigin` (multipart Library,
file proxy and transcription writes) and `requireExactBrowserOrigin` (ACP answers, secret requests).
Local development only: deployed installations never take this branch.

## Plan and acceptance

- [x] Admit only the Vite app origin, `http://localhost:5173` or `http://127.0.0.1:5173`
      (`LOCAL_DEVELOPMENT_APP_PORT`, `server.port` in `apps/web/vite.config.ts`), and only when
      `BASE_DOMAIN` is local. Non-local behavior is unchanged.
- [x] Tests: other loopback ports and a portless loopback origin are refused; the Vite origin on
      both hosts is still admitted; the strict interaction guard follows the same rule. Four new
      cases fail on the old predicate.
- [ ] Review, exact-head CI, staging, merge, production deploy (after #2994).
