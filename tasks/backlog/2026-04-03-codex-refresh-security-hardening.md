# Fix Deferred Security Findings from Codex Token Refresh Proxy (PR #600)

## Problem Statement

PR #600 (codex-token-refresh-proxy) shipped with deferred security findings from specialist reviewers. CRITICAL/HIGH actionable items were fixed pre-merge, but these items were explicitly deferred and need follow-up.

## Research Findings

### 1. Token-in-URL (HIGH)
- The endpoint at `apps/api/src/routes/codex-refresh.ts:47` extracts the callback token from `?token=` query param
- This is a hard constraint — Codex CLI's built-in refresh logic cannot set custom HTTP headers
- The VM agent injects `CODEX_REFRESH_TOKEN_URL_OVERRIDE` with the token in the URL at `packages/vm-agent/internal/acp/session_host.go:884-908`
- Current callback token lifetime: **24 hours** (configurable via `CALLBACK_TOKEN_EXPIRY_MS`)
- Tokens are RS256-signed JWTs with workspace-scoped claims
- Mitigations needed: formal risk documentation, access logging already present via `log.info('codex_refresh.request_received')`

### 2. Scope Validation on Refreshed Tokens (HIGH)
- `apps/api/src/durable-objects/codex-refresh-lock.ts:210` parses new tokens from OpenAI but does not validate scopes
- OpenAI's token response may include a `scope` field
- Should warn-log (not hard block) when unexpected scopes appear, for backward compatibility with legacy tokens
- Implementation: after parsing `newTokens` at line 210, check for a `scope` field and log a warning if it contains unexpected values

### 3. Rate Limiting (MEDIUM)
- Existing rate limiting infrastructure at `apps/api/src/middleware/rate-limit.ts` — KV-based, per-user or per-IP, configurable
- `DEFAULT_RATE_LIMITS` object and factory functions for creating rate limit middleware
- The codex-refresh endpoint currently has NO rate limiting (relies on per-user DO serialization for correctness, but not abuse prevention)
- The endpoint uses workspace callback token auth (not session auth), so we need a custom approach: rate limit per workspaceId (extracted from the verified JWT)
- Env type at `apps/api/src/index.ts:124-192` already has `RATE_LIMIT_*` pattern
- Need to add `RATE_LIMIT_CODEX_REFRESH` to Env and `DEFAULT_RATE_LIMITS`

### 4. JWT Lifetime Review (MEDIUM)
- Callback token lifetime: 24h default (`apps/api/src/services/jwt.ts:36-39`, `CALLBACK_TOKEN_EXPIRY_MS`)
- Terminal token lifetime: 1h default (`TERMINAL_TOKEN_EXPIRY_MS`)
- MCP token TTL: 4h default (`MCP_TOKEN_TTL_SECONDS`)
- 24h is appropriate for workspace callback tokens since workspaces may run for extended periods
- The auto-refresh mechanism at 50% of lifetime (`CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO`) ensures tokens are renewed during heartbeats
- Document this design decision in secrets taxonomy

### Key Files
- `apps/api/src/routes/codex-refresh.ts` — Refresh endpoint (139 lines)
- `apps/api/src/durable-objects/codex-refresh-lock.ts` — Per-user lock DO (265 lines)
- `apps/api/src/middleware/rate-limit.ts` — Rate limiting middleware (229 lines)
- `apps/api/src/services/jwt.ts` — JWT signing/verification
- `apps/api/src/index.ts` — Env type, route registration
- `docs/architecture/secrets-taxonomy.md` — Secrets documentation
- `apps/api/tests/unit/routes/codex-refresh.test.ts` — Existing tests

## Implementation Checklist

### Token-in-URL Documentation
- [ ] Add "Accepted Risks" section to `docs/architecture/secrets-taxonomy.md`
- [ ] Document token-in-URL constraint, mitigations (short-lived JWT, scope enforcement, access logging), and accepted risk

### Scope Validation
- [ ] Add scope validation in `codex-refresh-lock.ts` after parsing upstream response (line ~210)
- [ ] Define expected scopes constant (configurable via `CODEX_EXPECTED_SCOPES`)
- [ ] Log warning (not error) when scope field present with unexpected values
- [ ] Pass through tokens regardless (warning only, not blocking)
- [ ] Add unit tests for scope validation (expected scopes, unexpected scopes, missing scope field)

### Rate Limiting
- [ ] Add `CODEX_REFRESH` to `DEFAULT_RATE_LIMITS` (default: 30 per hour per workspace)
- [ ] Add `RATE_LIMIT_CODEX_REFRESH` to Env type
- [ ] Create `rateLimitCodexRefresh()` factory function in rate-limit.ts
- [ ] Apply rate limiting in `codex-refresh.ts` after token verification (use workspaceId as identifier)
- [ ] Add unit tests for rate limiting behavior (allowed, exceeded)

### JWT Lifetime Documentation
- [ ] Add JWT lifetime reference table to secrets taxonomy
- [ ] Document callback token 24h lifetime rationale and auto-refresh mechanism

### Documentation Sync
- [ ] Update CLAUDE.md recent changes if needed

## Acceptance Criteria
- [ ] Token-in-URL risk formally documented in secrets taxonomy with mitigations
- [ ] Scope validation added to token refresh response (warning log, not hard block)
- [ ] Rate limiting added to `/api/auth/codex-refresh` endpoint
- [ ] JWT lifetime for workspace callback tokens reviewed and documented
- [ ] Tests cover rate limiting behavior and scope validation
