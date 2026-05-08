# Port Access Tokens for Exposed Ports

## Problem

PR #928 ("harden workspace proxy ownership", `f2f533cf`, merged 2026-05-08) added session cookie auth + userId ownership to the workspace proxy in `apps/api/src/index.ts`. This broke exposed port access because:

1. BetterAuth session cookies are scoped to `api.{BASE_DOMAIN}` — NOT sent to `ws-{id}--{port}.{BASE_DOMAIN}` subdomains
2. The `?token=` fallback requires a terminal token, but `expose_port` returns a bare URL with no token
3. Users opening an exposed port URL in the browser have neither a cookie nor a token → 401 UNAUTHORIZED

## Research Findings

- **Root cause**: `apps/api/src/index.ts` lines 188-195 — workspace proxy requires session cookie or `?token=` but neither is available on `ws-*--*` subdomains
- **expose_port flow**: MCP handler → VM agent → returns bare `externalUrl` with no auth token
- **Existing token types**: terminal (`workspace-terminal` audience), callback (`workspace-callback`), port-proxy (terminal with `sub: 'port-proxy'` — Worker→VM only)
- **Cookie domain**: BetterAuth cookies scoped to `api.{BASE_DOMAIN}`, not wildcard
- **Plan reviewed by**: security-auditor (3 HIGH, 4 MEDIUM addressed), ui-ux-specialist (1 HIGH, 2 MEDIUM addressed)

## Implementation Checklist

- [ ] **Step 1**: Add `signPortAccessToken` / `verifyPortAccessToken` in `apps/api/src/services/jwt.ts`
  - New `PORT_ACCESS_AUDIENCE = 'port-access'` constant
  - Claims: `{ workspace, port, sub (userId), aud, iss, exp, iat }`
  - 15-minute default expiry (`PORT_ACCESS_TOKEN_EXPIRY_MS`)
- [ ] **Step 2**: Add env vars to `apps/api/src/env.ts`
  - `PORT_ACCESS_TOKEN_EXPIRY_MS` (default 900000)
  - `PORT_ACCESS_COOKIE_MAX_AGE_SECONDS` (default 14400)
- [ ] **Step 3**: Embed token in `handleExposePort()` response (`apps/api/src/routes/mcp/workspace-tools.ts`)
  - Sign port-access JWT after VM agent response
  - Append `?port_token={jwt}` to `externalUrl`
- [ ] **Step 4**: Update `expose_port` tool description (`apps/api/src/routes/mcp/tool-definitions-workspace-tools.ts`)
  - Mention time-limited URL, suggest markdown link syntax
- [ ] **Step 5**: Workspace proxy auth changes (`apps/api/src/index.ts`)
  - 5a: Cookie check — parse `sam_port_access` cookie, verify, validate workspace+port
  - 5b: Token check — parse `?port_token`, verify, set cookie, 302 redirect to strip token
  - 5c: Preserve existing session/terminal-token auth paths
  - 5d: Strip `port_token` from URL before logging
  - 5e: Strip `Set-Cookie` from container responses on port-proxy path
  - 5f: HTML error page for expired/invalid port access (not JSON)
- [ ] **Step 6**: Verify D1 ownership check runs on every request (cookie + token paths)
- [ ] **Step 7**: Tests
  - Unit: sign/verify round-trip, wrong workspace, wrong port, expired, audience isolation
  - Proxy: cookie handshake, 302 redirect, cross-port rejection, cross-workspace rejection, HTML error page, Set-Cookie stripping
  - MCP: expose_port includes `?port_token=` in URL
- [ ] **Step 8**: Update `docs/architecture/callback-auth-contract.md` and CLAUDE.md

## Acceptance Criteria

- [ ] `expose_port` MCP tool returns a URL with `?port_token=` embedded
- [ ] Opening the URL in browser: validates token, sets cookie, 302-redirects to clean URL
- [ ] Subsequent requests authenticated via `sam_port_access` cookie
- [ ] Token scoped per-port: token for port 3000 rejected on port 8080
- [ ] Token scoped per-workspace: token for workspace A rejected on workspace B
- [ ] Expired token/cookie shows HTML error page with recovery instructions
- [ ] `port_token` stripped from logged URLs
- [ ] Container `Set-Cookie` headers stripped from port-proxy responses
- [ ] Existing terminal token and session cookie auth unaffected
- [ ] All env vars configurable (PORT_ACCESS_TOKEN_EXPIRY_MS, PORT_ACCESS_COOKIE_MAX_AGE_SECONDS)

## References

- Plan: `/home/node/.claude/plans/rippling-finding-widget.md`
- PR #928: `f2f533cf` (the breaking change)
- Security review: 3 HIGH addressed (token expiry → 15min, SameSite → Strict, log sanitization)
- UX review: HTML error page, tool description update
- `.claude/rules/06-technical-patterns.md` — CORS, credential lifecycle
- `.claude/rules/23-cross-boundary-contract-tests.md` — contract verification
