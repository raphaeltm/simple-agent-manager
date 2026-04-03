# Centralized Codex Token Refresh Proxy

## Problem

OpenAI Codex uses rotating OAuth refresh tokens — when any Codex instance refreshes, the old refresh token is permanently invalidated. If two workspaces try to refresh concurrently, one gets `refresh_token_reused` and is permanently broken. SAM needs a centralized refresh proxy that serializes token refreshes per user.

Codex has a built-in env var `CODEX_REFRESH_TOKEN_URL_OVERRIDE` that redirects where it sends refresh requests. SAM sets this to point at its own API endpoint. One new API endpoint + one env var injection in the VM agent.

## Research Findings

### Auth Mechanism
- Workspace callback token (JWT, RS256) is available in `GatewayConfig.CallbackToken` and `GatewayConfig.ControlPlaneURL`
- `verifyCallbackToken()` in `services/jwt.ts` validates the JWT
- For the refresh endpoint, the token must be passed as `?token=` query param since Codex POSTs to the URL directly (cannot add headers)
- Resolve: token → workspace → userId → credential

### Credential Storage
- Credentials stored in `credentials` table with `(userId, agentType, credentialKind)` unique index
- AES-256-GCM encryption with per-record IV, key from `getCredentialEncryptionKey(env)`
- `encrypt()` / `decrypt()` in `services/encryption.ts`
- Existing sync-back endpoint at `POST /workspaces/:id/agent-credential-sync` follows same pattern

### VM Agent
- `getAgentCommandInfo()` in `gateway.go:733` returns static info per agent type
- For openai-codex + oauth-token: `injectionMode: "auth-file"`, `authFilePath: ".codex/auth.json"`
- Runtime env vars injected in `session_host.go:startAgent()` around line 873-900
- `ControlPlaneURL` and `CallbackToken` available in `h.config`
- Best place to add `CODEX_REFRESH_TOKEN_URL_OVERRIDE`: in session_host.go after auth-file injection (line ~880), similar to `NO_BROWSER=1`

### Route Mounting
- Auth routes mounted at `/api/auth` in `index.ts:703-704`
- `smokeTestTokenRoutes` mounted BEFORE `authRoutes` to avoid BetterAuth catch-all
- New codex-refresh route should be mounted similarly before authRoutes
- CORS not an issue — Codex calls from inside container (server-to-server), not browser

### Durable Objects
- All DOs extend `DurableObject<Env>` pattern
- DO bindings go in top-level `wrangler.toml` only (sync script generates env sections)
- New `CodexRefreshLock` DO keyed by userId — no SQLite needed, just DO single-threaded guarantee
- Env interface in `apps/api/src/index.ts:63`

### Request/Response Format (hardcoded in Codex — cannot change)
- Request: `{ "client_id": "...", "grant_type": "refresh_token", "refresh_token": "..." }`
- Response: `{ "access_token": "...", "refresh_token": "...", "id_token": "..." }` (all optional)
- Error: 401 + `{ "error": "refresh_token_expired" }` for permanent, 5xx for transient (Codex retries)

## Implementation Checklist

- [x] 1. Create `CodexRefreshLock` Durable Object (`apps/api/src/durable-objects/codex-refresh-lock.ts`)
  - Extends `DurableObject<Env>`
  - `fetch()` handler that receives refresh requests and serializes them
  - Compares request refresh_token with stored credential
  - Match: forward to upstream OpenAI, store new tokens, return them
  - No match (stale): return latest tokens from DB
  - No credential: return 401
  - Configurable lock timeout, upstream URL, upstream timeout
- [x] 2. Create refresh proxy route (`apps/api/src/routes/auth/codex-refresh.ts`)
  - `POST /codex-refresh` endpoint
  - Extract token from `?token=` query param
  - Verify callback token via `verifyCallbackToken()`
  - Look up workspace → userId
  - Forward to CodexRefreshLock DO by userId
  - Kill switch: `CODEX_REFRESH_PROXY_ENABLED` env var
- [x] 3. Mount route in `apps/api/src/index.ts`
  - Mount BEFORE authRoutes to avoid BetterAuth catch-all interference
  - Export CodexRefreshLock DO class
- [x] 4. Add DO binding to `apps/api/wrangler.toml` top-level section
  - Binding name: `CODEX_REFRESH_LOCK`
  - Migration tag for new class
- [x] 5. Add to Env interface in `apps/api/src/index.ts`
  - `CODEX_REFRESH_LOCK: DurableObjectNamespace`
  - New env var types for configuration
- [x] 6. VM agent: inject `CODEX_REFRESH_TOKEN_URL_OVERRIDE` in `session_host.go`
  - After auth-file injection block (line ~880)
  - Only for openai-codex + oauth-token (auth-file mode)
  - Value: `{ControlPlaneURL}/api/auth/codex-refresh?token={CallbackToken}`
- [x] 7. Add env vars to `apps/api/.env.example`
  - `CODEX_REFRESH_PROXY_ENABLED`, `CODEX_REFRESH_LOCK_TIMEOUT_MS`, `CODEX_REFRESH_UPSTREAM_URL`, `CODEX_REFRESH_UPSTREAM_TIMEOUT_MS`
- [x] 8. Update `docs/guides/self-hosting.md` with refresh proxy documentation
- [x] 9. Write unit tests for refresh proxy endpoint
  - Match case (forward to OpenAI)
  - Stale case (return from DB)
  - No credential case (401)
  - Kill switch disabled
  - Lock timeout
- [x] 10. Write contract tests (included in unit test file)
  - Request format matches Codex hardcoded format
  - Response format matches what Codex expects
  - Error format matches Codex error parsing
- [x] 11. Concurrent refresh handled by DO single-threaded guarantee (tested via DO error forwarding test)

## Acceptance Criteria

- [ ] Codex refresh requests are intercepted and proxied through SAM
- [ ] Per-user locking prevents concurrent refresh race conditions
- [ ] Stale refresh tokens return latest tokens from DB instead of hitting OpenAI
- [ ] Missing credentials return 401 with proper error format
- [ ] Kill switch (`CODEX_REFRESH_PROXY_ENABLED=false`) disables the proxy
- [ ] All timeouts and URLs are configurable via environment variables
- [ ] VM agent injects `CODEX_REFRESH_TOKEN_URL_OVERRIDE` for openai-codex oauth-token sessions
- [ ] Existing credential sync-back mechanism remains unchanged (belt-and-suspenders)
- [ ] No UI changes, no schema changes, no shared type changes

## References

- Idea: "Centralized Codex Token Refresh Proxy" (01KN9GTZ97CPV9SCMQCEPKJCTP)
- `packages/vm-agent/internal/acp/gateway.go:720-760` — agent command info
- `packages/vm-agent/internal/acp/session_host.go:866-900` — env var injection
- `apps/api/src/routes/workspaces/runtime.ts:71-162` — credential sync endpoint
- `apps/api/src/routes/workspaces/_helpers.ts:96-160` — callback auth verification
- `apps/api/src/services/encryption.ts` — AES-256-GCM encrypt/decrypt
- `apps/api/src/services/jwt.ts` — callback token verification
