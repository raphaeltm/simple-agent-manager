# Wire AI Proxy for Universal Usage Tracking

**Created**: 2026-05-01
**Idea**: 01KQHA51Y9N29Q4EE8F0BWVAQZ (Phases 2, 3, 4)
**Prerequisite**: Task 01KQH8X17FKYZKWETZXZ22M84W (Unified Billing) — merged PR #868

## Problem Statement

Currently, AI proxy credential fallback only activates when a user has NO credentials configured. Users with their own API keys bypass the proxy entirely, making their usage invisible to the platform's AI Gateway analytics. This means:

- No cost tracking for BYOK users
- No rate limiting for BYOK users
- No model analytics for BYOK users
- Incomplete usage dashboards

The fix: ALWAYS route through the AI proxy regardless of credential source. Users with their own keys still use them, but through URL-path-based proxy routes that embed the workspace token in the URL path (freeing auth headers for user credentials).

## Research Findings

### Current Architecture

1. **`runtime.ts:POST /:id/agent-key`** (lines 35-177): Returns credential + inferenceConfig. Currently, proxy fallback only triggers when `!credentialData && PROXY_ELIGIBLE_AGENTS.has(body.agentType) && aiProxyEnabled` (line 83).

2. **`ai-proxy-anthropic.ts`**: Native Anthropic proxy at `/ai/anthropic/v1/messages`. Auth via `extractCallbackToken()` from `Authorization: Bearer` or `x-api-key` headers.

3. **`ai-proxy.ts`**: OpenAI-compat proxy at `/ai/v1/chat/completions`. Auth via same header extraction.

4. **`session_host.go`** (lines 946-1044): Three credential injection paths:
   - `auth-file`: Codex OAuth token written to file
   - `callback-token` + `inferenceConfig`: Platform proxy mode (sets `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`)
   - else: Direct env var injection (`ANTHROPIC_API_KEY=<key>`)

5. **`ai-billing.ts`**: `resolveUpstreamAuth()` resolves billing headers. `resolveUnifiedBillingToken()` tries `CF_AIG_TOKEN ?? CF_API_TOKEN`.

### Design (from idea 01KQHA51Y9N29Q4EE8F0BWVAQZ)

**Phase 2 — URL-path proxy auth routes**: New routes `/ai/proxy/:wstoken/anthropic/*` and `/ai/proxy/:wstoken/openai/*` that extract the workspace token from the URL path instead of auth headers. This allows user credentials to pass through in standard auth headers (`x-api-key`, `Authorization: Bearer`).

**Phase 3 — Proxy credential resolution**: Modify `runtime.ts` to return proxy config with `inferenceConfig` when AI proxy is enabled and the credential can be forwarded to the upstream provider. Modify `session_host.go` to support a "proxy-passthrough" mode that sets base URL but preserves user's auth header value. Claude Code OAuth tokens are excluded from Anthropic passthrough because they must be injected as `CLAUDE_CODE_OAUTH_TOKEN`, not forwarded as Anthropic API keys.

**Phase 4 — Codex config.toml**: Handle Codex `OPENAI_BASE_URL` bug (issue #16719) if needed. May need to inject a custom provider section in config.toml.

## Implementation Checklist

### Phase 2: URL-Path Proxy Routes

- [x] Create `apps/api/src/routes/ai-proxy-passthrough.ts` with:
  - `POST /anthropic/v1/messages` — extract `:wstoken`, verify via `verifyAIProxyAuth()`, forward to Anthropic gateway with user's `x-api-key` header as upstream auth
  - `POST /anthropic/v1/messages/count_tokens` — same pattern for token counting
  - `POST /openai/v1/chat/completions` — extract `:wstoken`, verify, forward to OpenAI-compat gateway
  - Shared: `cf-aig-metadata` header injection for analytics, rate limiting, token budget checks
  - Key difference from existing proxies: upstream auth uses the USER's credential from request headers (forwarded as-is) instead of `resolveUpstreamAuth()`
- [x] Mount new routes at `/ai/proxy/:wstoken` in `index.ts`
- [x] Add tests for URL-path auth extraction and passthrough behavior

### Phase 3: Proxy Credential Resolution

- [x] Modify `runtime.ts:POST /:id/agent-key` to return `inferenceConfig` with proxy config when `aiProxyEnabled` and the credential is upstream-compatible
  - When user has API-key credentials: return `inferenceConfig` with `apiKeySource: 'user-credential'` (new mode) — VM agent will set base URL but use user's own key in auth header
  - When Claude Code uses an OAuth token: return the credential directly so VM agent injects `CLAUDE_CODE_OAUTH_TOKEN`
  - When no user credentials: existing `apiKeySource: 'callback-token'` behavior unchanged
- [x] Add `apiKeySource: 'user-credential'` to shared types if needed
- [x] Update `session_host.go` to handle `apiKeySource == "user-credential"`:
  - Set `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` to the proxy URL (with wstoken in path)
  - Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` to the user's actual credential
  - The proxy route will read the user credential from the auth header and forward it upstream
- [x] Add `gateway.go` type updates if needed for the new `apiKeySource` value (not needed — existing types sufficient)

### Phase 4: Codex Config.toml Handling

- [x] Investigate whether Codex respects `OPENAI_BASE_URL` in current version
  - **Result**: Codex respects `OPENAI_BASE_URL` env var. No config.toml changes needed — Phase 3 env var injection is sufficient.
- [x] If Codex respects `OPENAI_BASE_URL`: no additional work needed (Phase 3 env var injection is sufficient) ✓

### Tests

- [x] Unit tests for URL-path token extraction (ai-proxy-passthrough.test.ts — 9 tests)
- [x] Integration tests for passthrough proxy (mock upstream, verify headers forwarded)
- [x] Test `runtime.ts` proxy logic: user with upstream-compatible credentials gets `inferenceConfig`; Claude Code OAuth remains direct (runtime-always-proxy.test.ts)
- [x] Test `runtime.ts` backward compat: user without credentials still works (callback-token mode)
- [x] Test passthrough mode: user credential in header reaches upstream
- [x] Updated existing fallback tests (claude-code-proxy-fallback, codex-proxy-fallback) for always-proxy behavior

### Documentation

- [x] Update CLAUDE.md Recent Changes section
- [x] Update `apps/api/.env.example` if new env vars added (no new env vars — reuses existing AI_PROXY_* vars)

## Acceptance Criteria

- [x] Users with their own API keys have all LLM calls routed through AI proxy
- [x] AI Gateway `cf-aig-metadata` header is present on all proxied requests (BYOK and platform)
- [x] User credentials are forwarded to upstream provider (not replaced by platform credentials)
- [x] Users without credentials still use platform proxy (existing behavior preserved)
- [x] Rate limiting and token budgets apply to all users (BYOK and platform)
- [x] No regression in existing proxy endpoints (`/ai/v1`, `/ai/anthropic/v1`)
- [ ] Staging verification: run agent session with OAuth user, verify usage appears in AI Gateway logs
