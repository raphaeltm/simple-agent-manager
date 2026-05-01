# AI Proxy Anthropic Route: Unified Billing Support

## Problem

The native Anthropic AI proxy route (`ai-proxy-anthropic.ts`) calls `resolveAnthropicApiKey()` which only resolves a stored platform credential. It completely bypasses `resolveUpstreamAuth()` from `ai-billing.ts`, which handles Cloudflare Unified Billing via `cf-aig-authorization` headers. This means the Anthropic route always requires a separate platform Anthropic API key, even when Unified Billing is available.

Additionally, `resolveUpstreamAuth()` only checks `env.CF_AIG_TOKEN` but `CF_API_TOKEN` (which already exists as a Worker secret) can serve the same purpose. The OpenAI-compat proxy (`ai-proxy.ts`) also bypasses `resolveUpstreamAuth()` for Anthropic models, checking `CF_AIG_TOKEN` directly.

## Research Findings

### Key Files
- `apps/api/src/routes/ai-proxy-anthropic.ts` — Native Anthropic proxy, uses `resolveAnthropicApiKey()` at lines 144 and 335
- `apps/api/src/services/ai-billing.ts` — Has `resolveUpstreamAuth()` with proper unified/platform-key/auto logic, but only checks `CF_AIG_TOKEN`
- `apps/api/src/services/ai-proxy-shared.ts` — Contains `resolveAnthropicApiKey()` (lines 121-128) which just does platform credential lookup
- `apps/api/src/routes/ai-proxy.ts` — OpenAI-compat proxy; bypasses `resolveUpstreamAuth()` for Anthropic at lines 464-476, uses ad-hoc `CF_AIG_TOKEN` check
- `apps/api/src/env.ts` — `CF_API_TOKEN` is required (line 59), `CF_AIG_TOKEN` is optional (line 517)

### Current Behavior
1. **Anthropic proxy**: Always calls `resolveAnthropicApiKey()` → always needs platform credential → always sends `x-api-key`
2. **OpenAI-compat proxy (Anthropic path)**: Checks `CF_AIG_TOKEN` directly, skips credential lookup if present, but `forwardToAnthropic()` always sends `x-api-key` header — never sends `cf-aig-authorization`
3. **OpenAI-compat proxy (OpenAI path)**: Has ad-hoc unified billing logic in `forwardToOpenAI()` (lines 287-300) that checks `CF_AIG_TOKEN` directly
4. **`resolveUpstreamAuth()`**: Properly handles all 3 billing modes but is unused by both proxy routes for Anthropic models

### Desired Behavior
Both proxy routes should use `resolveUpstreamAuth()` for Anthropic models. When billing mode is `unified` or `auto` with token available, send `cf-aig-authorization: Bearer <token>`. When falling back to platform key, send `x-api-key`. `cf-aig-metadata` must always be sent regardless of billing mode.

## Implementation Checklist

- [ ] **ai-billing.ts**: Update `resolveUpstreamAuth()` to use `env.CF_AIG_TOKEN ?? env.CF_API_TOKEN` instead of just `env.CF_AIG_TOKEN`
- [ ] **ai-proxy-anthropic.ts /messages**: Replace `resolveAnthropicApiKey()` with `resolveUpstreamAuth()`, spread auth headers into upstream headers
- [ ] **ai-proxy-anthropic.ts /count_tokens**: Same replacement for the token counting endpoint
- [ ] **ai-proxy.ts**: Refactor Anthropic model path in main handler to use `resolveUpstreamAuth()` instead of ad-hoc `CF_AIG_TOKEN` + `resolveAnthropicApiKey()` check
- [ ] **ai-proxy.ts forwardToAnthropic()**: Accept auth headers from `resolveUpstreamAuth()` instead of raw API key; spread auth headers instead of hardcoding `x-api-key`
- [ ] **Metadata**: Verify `cf-aig-metadata` is sent in all billing modes (already done in anthropic proxy, verify in OpenAI-compat)
- [ ] **Remove `resolveAnthropicApiKey()`**: After all callers are migrated, remove it from `ai-proxy-shared.ts` and clean up imports
- [ ] **Tests**: Update `ai-billing.test.ts` to cover `CF_API_TOKEN` fallback
- [ ] **Tests**: Add tests for anthropic proxy unified billing paths (unified mode sends cf-aig-authorization, platform-key sends x-api-key)
- [ ] **Tests**: Update ai-proxy.ts tests if Anthropic path changed
- [ ] **Docs**: Update CLAUDE.md Recent Changes section

## Acceptance Criteria

- [ ] Anthropic proxy route uses `resolveUpstreamAuth()` and sends `cf-aig-authorization` when in unified/auto mode
- [ ] When no `CF_AIG_TOKEN` and no `CF_API_TOKEN` are set, auto mode falls back to platform credential
- [ ] `CF_API_TOKEN` works as a fallback for `CF_AIG_TOKEN` in unified billing resolution
- [ ] `cf-aig-metadata` header is sent regardless of billing mode
- [ ] OpenAI-compat proxy uses `resolveUpstreamAuth()` for Anthropic models consistently
- [ ] `resolveAnthropicApiKey()` is removed from the codebase (no remaining callers)
- [ ] All existing tests pass
- [ ] New tests cover unified billing paths for both proxy routes
- [ ] No hardcoded API keys or billing mode defaults (constitution Principle XI)

## References
- Cloudflare Unified Billing docs: https://developers.cloudflare.com/ai-gateway/features/unified-billing/
- tasks/backlog/2026-05-01-ai-proxy-unified-billing-and-user-credential-passthrough.md (parent task — this covers Phase 1 only)
