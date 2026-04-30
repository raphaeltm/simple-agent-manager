# WP6: Model Catalog Expansion

## Problem

SAM's platform AI model catalog has only 4 models. With Cloudflare AI Gateway Unified Billing, SAM can offer Anthropic (Claude Sonnet/Opus/Haiku) and OpenAI (GPT-4.1, GPT-5.2) models alongside Workers AI models without requiring separate provider API keys. The catalog needs tier classification (free/standard/premium) and cost estimation fields for budget-aware usage.

## Research Findings

### Key Files
- `packages/shared/src/constants/ai-services.ts` — `PlatformAIModel` interface and `PLATFORM_AI_MODELS` array (4 models)
- `apps/api/src/routes/ai-proxy.ts` — Model routing: `isAnthropicModel()`, `normalizeModelId()`, `resolveModelId()`, `forwardToWorkersAI()`, `forwardToAnthropic()`
- `apps/api/src/routes/admin-ai-proxy.ts` — Admin config GET/PUT/DELETE for default model
- `apps/web/src/pages/AdminAIProxy.tsx` — Admin UI model picker
- `apps/web/src/lib/api/admin.ts` — `AIProxyConfigResponse` type and fetch functions
- `apps/api/tests/unit/routes/ai-proxy.test.ts` — Existing model resolution tests

### Current Architecture
- Provider routing uses `isAnthropicModel()` which checks `modelId.startsWith('claude-')` — works for Anthropic but no OpenAI detection
- `normalizeModelId()` handles `workers-ai/` prefix stripping and `@cf/` prefix addition — needs OpenAI model handling
- AI Gateway URL builders exist for Workers AI and Anthropic but not OpenAI
- Anthropic format translation (`ai-anthropic-translate.ts`) handles OpenAI→Anthropic Messages API conversion
- OpenAI models go through AI Gateway's `/openai/v1/chat/completions` path — format is already OpenAI-native, so no translation needed
- Admin config validates against `PLATFORM_AI_MODELS` list — new models will automatically be selectable
- `AIProxyConfigResponse.models` includes `provider` and `available` fields — needs `tier` and cost fields

### AI Gateway Model ID Format
- Workers AI: `@cf/meta/llama-4-scout-17b-16e-instruct`
- Anthropic via Gateway: `claude-sonnet-4-6` (mapped to Gateway `/anthropic` path)
- OpenAI via Gateway: `gpt-4.1` (mapped to Gateway `/openai` path)

## Implementation Checklist

- [ ] 1. Add `tier` and cost fields to `PlatformAIModel` interface in `ai-services.ts`
- [ ] 2. Add `'openai'` to provider union type
- [ ] 3. Expand `PLATFORM_AI_MODELS` with Claude Sonnet 4.6, Opus 4.6, GPT-4.1, GPT-4.1-mini, GPT-5.2
- [ ] 4. Add `isOpenAIModel()` detection function in `ai-proxy.ts`
- [ ] 5. Update `normalizeModelId()` to handle OpenAI model IDs
- [ ] 6. Add `buildOpenAIUrl()` for AI Gateway OpenAI path
- [ ] 7. Add `forwardToOpenAI()` function (OpenAI-native format, no translation needed)
- [ ] 8. Update main route handler to route OpenAI models through `forwardToOpenAI()`
- [ ] 9. Update `/models` endpoint `owned_by` to include `'openai'`
- [ ] 10. Update `AIProxyConfigResponse` in `admin.ts` to include `tier` and cost fields
- [ ] 11. Update `AdminAIProxy.tsx` to show models grouped by tier with cost info
- [ ] 12. Update admin config PUT validation for OpenAI models (require OpenAI credential or Unified Billing)
- [ ] 13. Add OpenAI model tests to `ai-proxy.test.ts`
- [ ] 14. Rebuild shared package
- [ ] 15. Playwright visual audit of admin model picker (375px + 1280px)

## Acceptance Criteria

- [ ] All new model IDs recognized by `normalizeModelId()` and routed to correct provider
- [ ] OpenAI models route to correct AI Gateway path (`/openai/v1/chat/completions`)
- [ ] Model tier classification (free/standard/premium) correctly assigned
- [ ] Cost per 1K tokens fields populated for budget estimation
- [ ] Admin UI displays models grouped by tier with cost information
- [ ] Existing Workers AI and Anthropic model routing unchanged
- [ ] Unit tests cover all new model IDs, routing, and detection
- [ ] Playwright visual audit passes on mobile and desktop

## References
- Task WP6 from SAM task 01KQG844GB9BZJ0YN611FG4K4V
