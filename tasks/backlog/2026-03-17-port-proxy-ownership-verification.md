# Port Proxy Ownership Verification

**Created**: 2026-03-17
**Discovered during**: Security audit of PR #439 (port proxy Host header fix)
**Severity**: HIGH

## Problem

The port proxy path in the Worker (`apps/api/src/index.ts`) issues a JWT for any request arriving on a workspace's port subdomain (`ws-{id}--{port}.{baseDomain}`) without verifying that the requesting user owns the workspace. The only gate is knowing the workspace UUID (which is the subdomain).

This mirrors the existing terminal proxy auth model — both paths issue JWTs based solely on workspace existence, not ownership. The workspace IDs are UUIDs and subdomains are not publicly listed, but this is security-by-obscurity.

Additionally, the JWT `sub` claim is set to the literal string `'port-proxy'` rather than a real user ID, which corrupts audit trails.

## Context

- The port proxy and terminal proxy share the same auth pattern via `signTerminalToken()`
- Workspace IDs are UUIDs (not guessable) and subdomains are not publicly listed
- The VM agent validates the JWT workspace claim matches the path parameter
- This is a pre-existing architectural pattern, not specific to the port proxy fix

## Acceptance Criteria

- [ ] Port proxy JWT issuance requires a valid user session (cookie or auth header)
- [ ] The JWT `sub` claim contains the real authenticated user ID, not a literal string
- [ ] Terminal proxy auth is updated to match (same pattern)
- [ ] Unauthenticated requests to port subdomains return 401, not a valid JWT
- [ ] Add a `type: 'port-proxy'` claim to distinguish port-proxy tokens from terminal tokens
- [ ] Consider shorter TTL for port-proxy tokens (`PORT_PROXY_TOKEN_EXPIRY_MS`, default 5 min)

## Additional Security Improvements (from audit)

- [ ] Add explicit hostname character validation for `workspaceID` in Go port proxy Director (`^[a-f0-9-]+$`)
- [ ] Document the intentional `SameSite=Lax` downgrade for cross-subdomain cookies in `session.go`
