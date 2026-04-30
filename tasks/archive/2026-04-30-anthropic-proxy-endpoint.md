# WP1: Anthropic-Format Proxy Endpoint

## Problem Statement

Claude Code communicates via the Anthropic Messages API format (`/v1/messages`) and authenticates with `x-api-key`. SAM's existing AI proxy only supports OpenAI-compatible format (`/ai/v1/chat/completions`) with `Authorization: Bearer`. We need a native Anthropic-format pass-through proxy at `/ai/anthropic/v1/messages` so Claude Code can use SAM's proxy via `ANTHROPIC_BASE_URL`.

## Research Findings

### Existing AI Proxy (`apps/api/src/routes/ai-proxy.ts`)
- Mounted at `/ai/v1` in `index.ts` (line 431)
- Auth: `Authorization: Bearer <callback-token>` → `verifyCallbackToken()` → workspace lookup → userId/projectId
- Rate limiting: per-user RPM via KV (`checkRateLimit()` from `middleware/rate-limit.ts`)
- Token budget: per-user daily limits via KV (`checkTokenBudget()` from `services/ai-token-budget.ts`)
- For Anthropic models: translates OpenAI format → Anthropic format → AI Gateway `/anthropic/v1/messages`
- Upstream auth: `x-api-key` with platform Anthropic credential from `getPlatformAgentCredential(db, 'claude-code', encryptionKey)`
- Metadata: `cf-aig-metadata` header with JSON `{userId, workspaceId, projectId, trialId, modelId, stream, hasTools}`

### Key Differences for New Endpoint
- **No format translation needed** — receives native Anthropic format, forwards native Anthropic format
- **Auth via `x-api-key` header** instead of `Authorization: Bearer` (Claude Code sends auth this way)
- **Forward Anthropic-specific headers**: `anthropic-version`, `anthropic-beta`
- **SSE streaming pass-through** — no transform stream needed, just pipe response body
- **Model validation** — only allow Anthropic models (claude-*)
- **Additional endpoint**: `/count_tokens` for token counting

### Upstream URL
- AI Gateway: `https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/{AI_GATEWAY_ID}/anthropic/v1/messages`
- Fallback (no gateway): `https://api.anthropic.com/v1/messages`

### Shared Helpers Needed
The following logic is duplicated between existing `ai-proxy.ts` and the new endpoint:
- Callback token verification + workspace/user resolution
- Rate limit checking (per-user RPM)
- Token budget checking
- AI Gateway metadata injection

Extract into `apps/api/src/services/ai-proxy-shared.ts` to avoid duplication.

## Implementation Checklist

- [x] 1. Create `apps/api/src/services/ai-proxy-shared.ts` with shared helpers
- [x] 2. Refactor existing `ai-proxy.ts` to use shared helpers (no behavior change)
- [x] 3. Create `apps/api/src/routes/ai-proxy-anthropic.ts`
- [x] 4. Mount new route at `/ai/anthropic/v1` in `apps/api/src/index.ts`
- [x] 5. Add unit tests in `apps/api/tests/unit/routes/ai-proxy-anthropic.test.ts`
- [x] 6. Add integration tests in worker-smoke.test.ts (route mounting verification)
- [ ] 7. Update CLAUDE.md Recent Changes section

## Implementation Notes

- Shared helpers extracted: `extractCallbackToken`, `verifyAIProxyAuth`, `buildAIGatewayMetadata`, `buildAnthropicGatewayUrl`, `buildAnthropicCountTokensUrl`, `resolveAnthropicApiKey`, `AIProxyAuthError`
- Rate limit and token budget functions remain in their original modules (called directly, not duplicated)
- Anthropic error format uses `{ type: "error", error: { type, message } }` to match Anthropic API conventions
- Worker smoke tests have a pre-existing workerd segfault in this environment; unit tests pass

## Acceptance Criteria

- [x] `POST /ai/anthropic/v1/messages` accepts Anthropic Messages API format and returns Anthropic format responses
- [x] Authentication works via `x-api-key` header with workspace callback token
- [x] `anthropic-version` and `anthropic-beta` headers are forwarded to upstream
- [x] SSE streaming responses are passed through without modification
- [x] Non-Anthropic models are rejected with appropriate error
- [x] Per-user rate limiting is enforced
- [x] Per-user daily token budget is enforced
- [x] `cf-aig-metadata` header is injected for cost attribution
- [x] Kill switch `AI_PROXY_ENABLED=false` disables the endpoint
- [x] `/ai/anthropic/v1/messages/count_tokens` endpoint exists
- [x] All configurable values use env var overrides (constitution Principle XI)
- [x] Unit tests cover auth, rate limiting, header forwarding, model validation, streaming, errors
- [x] Existing OpenAI-compatible proxy continues to work after refactor

## References

- `apps/api/src/routes/ai-proxy.ts` — existing proxy
- `apps/api/src/services/platform-credentials.ts` — `getPlatformAgentCredential()`
- `packages/shared/src/constants/ai-services.ts` — model definitions
- `apps/api/src/env.ts` — AI proxy env vars
- `apps/api/src/middleware/rate-limit.ts` — rate limit utilities
- `apps/api/src/services/ai-token-budget.ts` — token budget tracking
- `apps/api/src/services/jwt.ts` — `verifyCallbackToken()`
