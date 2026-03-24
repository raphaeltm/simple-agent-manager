# Identity Token Endpoint Rate Limiting

## Problem

The GCP identity token endpoint (`GET /api/projects/:id/deployment-identity-token`) performs RSA signing on every request with no rate limiting. An attacker or buggy agent could:
- Cause excessive CPU usage via RSA signing operations
- Generate unlimited tokens for a given workspace/project
- Potentially DoS the Worker

## Research Findings

### Key Files
- **Endpoint**: `apps/api/src/routes/project-deployment.ts:272-361` — identity token handler
- **Signing**: `apps/api/src/services/jwt.ts:281-329` — `signIdentityToken()` using RS256
- **Rate limit middleware**: `apps/api/src/middleware/rate-limit.ts` — reusable KV-based rate limiting
- **Env types**: `apps/api/src/index.ts:103-106` — existing `RATE_LIMIT_*` env vars
- **Tests**: `apps/api/tests/unit/routes/project-deployment.test.ts`

### Existing Pattern
The codebase has a well-established rate limiting pattern using Cloudflare KV:
- `rateLimit(config)` middleware using KV counters with configurable window
- `getRateLimit(env, key)` reads env var overrides with defaults
- `DEFAULT_RATE_LIMITS` object with named limits
- Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`)
- `RateLimitError` with 429 status and `Retry-After` header

### Challenge: Auth Model
The identity token endpoint uses custom Bearer token auth (MCP token or callback token), NOT the standard `requireAuth()` middleware. This means `c.get('auth')?.user?.id` is not available. The rate limiter needs to key by workspace ID, which is extracted during auth in the handler itself.

### Approach
1. **Per-workspace rate limiting**: Since the endpoint is called per-workspace (GCP client libraries use workspace-scoped credentials), rate limit by workspace ID.
2. **Token caching via KV**: Cache the signed token in KV keyed by `(workspaceId, audience)` with TTL slightly less than the token expiry. This avoids redundant RSA signing for repeated requests with the same scope.
3. **Reuse existing middleware infrastructure**: Add a new `IDENTITY_TOKEN` default rate limit and a `rateLimitIdentityToken()` function. Since auth happens inside the handler, apply rate limiting inline after auth resolution rather than as middleware.

## Implementation Checklist

- [ ] Add `IDENTITY_TOKEN` to `DEFAULT_RATE_LIMITS` in `rate-limit.ts` (default: 30/hour per workspace)
- [ ] Add `RATE_LIMIT_IDENTITY_TOKEN` to the `Env` interface in `index.ts`
- [ ] Add `rateLimitIdentityToken()` convenience function in `rate-limit.ts`
- [ ] Add inline rate limiting in the identity token handler after workspace ID is resolved, using `checkRateLimit` from the middleware (export it)
- [ ] Add KV-based token caching: before signing, check KV for cached token; after signing, store in KV with TTL = token expiry - 60s buffer
- [ ] Add `GCP_DEPLOY_IDENTITY_TOKEN_CACHE_ENABLED` env var (default: true) for cache toggle
- [ ] Write unit tests for rate limiting behavior (429 on excess, headers present, normal usage passes)
- [ ] Write unit tests for token caching behavior (cache hit returns cached token, cache miss signs new token)
- [ ] Update documentation if needed

## Acceptance Criteria

- [ ] Identity token endpoint has per-workspace rate limiting
- [ ] Rapid repeated requests are rejected with HTTP 429
- [ ] Normal agent usage (reasonable token refresh cadence) is unaffected
- [ ] Recently-signed tokens are cached and returned without re-signing
- [ ] All rate limit values are configurable via environment variables
- [ ] Tests verify rate limiting and caching behavior
