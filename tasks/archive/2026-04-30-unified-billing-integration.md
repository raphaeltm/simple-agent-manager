# Unified Billing Integration (cf-aig-authorization)

## Problem
SAM's AI proxy currently requires a stored platform Anthropic API key (`ANTHROPIC_API_KEY`) to route requests to Anthropic models. Cloudflare AI Gateway supports Unified Billing, which allows calling Anthropic/OpenAI/Google models using CF credits via the `cf-aig-authorization: Bearer <cf-api-token>` header instead of provider-specific API keys. Since `CF_API_TOKEN` is already a Worker secret, this eliminates the need for admins to manage separate provider API keys.

## Research Findings

### Key Files
- `apps/api/src/routes/ai-proxy.ts` — main proxy route, `forwardToAnthropic()` function (line 188-254), `forwardToWorkersAI()` (line 141-185)
- `apps/api/src/routes/admin-ai-proxy.ts` — admin config GET/PUT/DELETE endpoints, `hasAnthropicCredential()` check
- `apps/api/src/services/platform-credentials.ts` — `getPlatformAgentCredential()` for resolving stored API keys
- `apps/api/src/env.ts` — env var type definitions (AI_PROXY_* on lines 504-513)
- `packages/shared/src/constants/ai-services.ts` — shared constants, `AIProxyConfig` type, `AI_PROXY_DEFAULT_MODEL_KV_KEY`
- `apps/web/src/pages/AdminAIProxy.tsx` — admin UI for AI proxy config
- `apps/web/src/lib/api/admin.ts` — admin API client (`AIProxyConfigResponse` type)
- `apps/api/tests/unit/routes/ai-proxy.test.ts` — existing unit tests

### Current Flow
1. Anthropic model requests: resolve API key via `getPlatformAgentCredential(db, 'claude-code', encryptionKey)`, then `forwardToAnthropic()` sends `x-api-key: <key>` header
2. Workers AI model requests: `forwardToWorkersAI()` sends `Authorization: Bearer ${env.CF_API_TOKEN}` header — Workers AI already uses CF_API_TOKEN
3. Admin UI shows model picker and Anthropic credential status

### Key Observations
- `forwardToWorkersAI()` already uses `env.CF_API_TOKEN` for auth — Workers AI through Gateway uses the same token
- `forwardToAnthropic()` takes `anthropicApiKey` as parameter and sets `x-api-key` header
- The `AIProxyConfig` type in shared stores `defaultModel` and `updatedAt` — billing mode can be added here
- Admin config is stored in KV at key `platform:ai-proxy:default-model`
- WP1 (native Anthropic proxy) hasn't merged yet — implement billing mode as a shared helper
- Existing `PLATFORM_AI_MODELS` model list includes `provider` field — model availability currently depends on `hasAnthropicCredential`; with unified billing, Anthropic models become available when CF_API_TOKEN is set

## Implementation Checklist

### 1. Shared Constants & Types
- [ ] Add `AI_PROXY_BILLING_MODE_KV_KEY` to `packages/shared/src/constants/ai-services.ts`
- [ ] Add `BillingMode` type (`'unified' | 'platform-key' | 'auto'`) and `DEFAULT_AI_PROXY_BILLING_MODE` constant
- [ ] Export new constants from shared index

### 2. Env Type
- [ ] Add `AI_PROXY_BILLING_MODE?: string` to `Env` in `apps/api/src/env.ts`

### 3. Billing Mode Resolution Helper
- [ ] Create `resolveUpstreamAuth()` in `apps/api/src/services/ai-billing.ts`
  - Reads billing mode from KV > env > default ('auto')
  - 'unified'/'auto' with CF_API_TOKEN: returns `{ 'cf-aig-authorization': 'Bearer <token>' }` headers
  - 'unified' without CF_API_TOKEN: throws error
  - 'auto' without CF_API_TOKEN: falls back to platform credential
  - 'platform-key': uses existing `getPlatformAgentCredential()` logic
  - Returns `{ headers, billingMode }` for logging

### 4. AI Proxy Route Updates
- [ ] Modify `ai-proxy.ts` main handler to use `resolveUpstreamAuth()` instead of inline credential lookup
- [ ] Update `forwardToAnthropic()` to accept auth headers object instead of raw API key string
- [ ] Add `billingMode` to logging metadata
- [ ] Export `resolveUpstreamAuth` for WP1 consumption

### 5. Admin Config Endpoint Updates
- [ ] Add billing mode to GET response (`billingMode`, `hasCfApiToken`)
- [ ] Add PATCH endpoint for billing mode (store in KV)
- [ ] Model availability: Anthropic models available when `hasCfApiToken || hasAnthropicCredential`

### 6. Admin UI Updates
- [ ] Add billing mode selector (radio/toggle) to `AdminAIProxy.tsx`
- [ ] Show CF_API_TOKEN status (configured / not configured boolean)
- [ ] Update model availability display to reflect unified billing
- [ ] Update API client types in `admin.ts`

### 7. Tests
- [ ] Test `resolveUpstreamAuth()`: unified mode sets `cf-aig-authorization`, no `x-api-key`
- [ ] Test `resolveUpstreamAuth()`: platform-key mode sets `x-api-key`, no `cf-aig-authorization`
- [ ] Test `resolveUpstreamAuth()`: auto mode falls back when CF_API_TOKEN is missing
- [ ] Test `resolveUpstreamAuth()`: unified mode throws when CF_API_TOKEN is absent
- [ ] Test admin config GET returns billingMode and hasCfApiToken
- [ ] Test admin config PATCH updates billing mode in KV

### 8. Documentation
- [ ] Add `AI_PROXY_BILLING_MODE` to CLAUDE.md env var documentation (in ai-proxy-gateway section)

## Acceptance Criteria
- [ ] Anthropic models can be called with unified billing (cf-aig-authorization header) when CF_API_TOKEN is set
- [ ] Default mode ('auto') works zero-config: uses unified billing when CF_API_TOKEN exists, falls back to platform credential
- [ ] Platform-key mode preserves existing behavior (x-api-key header)
- [ ] Admin UI shows billing mode and allows toggling
- [ ] CF_API_TOKEN value is never exposed in API responses — only boolean presence
- [ ] All env vars are configurable (no hardcoded values)
- [ ] Existing tests continue to pass
- [ ] New tests cover all billing mode branches

## References
- Task ID: 01KQG83E5A8DY1TFXP33J0NAQR
- Output branch: sam/wp4-unified-billing-integration-01kqg8
