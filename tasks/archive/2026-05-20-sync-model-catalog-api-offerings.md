# Sync Model Catalog with Current API Offerings

## Problem

The UI model dropdown (`model-catalog.ts`) and the platform AI proxy allowlist (`PLATFORM_AI_MODELS` in `ai-services.ts`) were out of sync with what's actually available from the Anthropic and OpenAI APIs. Users selecting certain models from the dropdown would get "model not allowed" errors when using SAM provider mode. Additionally, retired models were still shown in the dropdown, and pricing/context window data was stale.

## Research Findings

### Anthropic API (verified May 2026)
- **Current**: claude-opus-4-7 (1M ctx), claude-opus-4-6 (1M ctx), claude-sonnet-4-6 (1M ctx), claude-haiku-4-5-20251001 (200k ctx)
- **Legacy**: claude-opus-4-5-20251101, claude-opus-4-1-20250805, claude-sonnet-4-5-20250929, claude-sonnet-4-20250514 (retiring Jun 15)
- **RETIRED**: claude-3-5-sonnet-20241022, claude-3-5-haiku-20241022, claude-3-opus-20240229 — no longer available via API
- **Wrong ID in our code**: claude-sonnet-4-5-20250514 should be claude-sonnet-4-5-20250929

### OpenAI API (verified May 2026)
- **Current**: gpt-5.5 ($5/$30), gpt-5.5-pro ($30/$180), gpt-5.4 ($2.50/$15), gpt-5.4-pro ($30/$180), gpt-5.4-mini ($0.75/$4.50), gpt-5.4-nano ($0.20/$1.25), gpt-5.3-codex ($1.75/$14)
- **Deprecating**: gpt-5.2-codex (Aug 10), gpt-5.1-codex-max/mini (Jul 23), gpt-5-mini (Aug 10), o3/o4-mini (Oct 23)
- **Legacy**: gpt-4.1, gpt-4.1-mini — still available
- **Not a valid model**: gpt-5.2 (only gpt-5.2-codex exists)

### Key Files
- `packages/shared/src/model-catalog.ts` — UI dropdown source
- `packages/shared/src/constants/ai-services.ts` — PLATFORM_AI_MODELS allowlist + cost data
- `apps/api/src/routes/ai-proxy.ts` — OpenAI proxy with model validation
- `apps/api/src/routes/ai-proxy-anthropic.ts` — Anthropic proxy (no model validation)

## Implementation Checklist

- [x] Remove retired Claude 3.x models from dropdown and allowlist
- [x] Fix claude-sonnet-4-5 ID (20250514 → 20250929)
- [x] Add missing Anthropic models (opus-4-5, opus-4-1)
- [x] Add missing OpenAI models (gpt-5.4-pro, gpt-5.4-nano, gpt-5-mini)
- [x] Remove invalid gpt-5.2 model ID
- [x] Fix context windows from API docs (Claude 4.6+ = 1M, GPT-5.4 = 400k)
- [x] Fix pricing from official API docs
- [x] Reorganize dropdown groups for clarity
- [x] Ensure every dropdown model has a matching PLATFORM_AI_MODELS entry
- [x] Verify builds pass (shared, providers, api)

## Acceptance Criteria

- [ ] All models in the dropdown exist in current Anthropic/OpenAI APIs
- [ ] All dropdown models have entries in PLATFORM_AI_MODELS
- [ ] No retired/unavailable models appear in the dropdown
- [ ] Pricing matches official API documentation
- [ ] Context windows match official API documentation
- [ ] Shared, providers, and API packages build successfully
- [ ] Staging deployment succeeds

## References

- Anthropic models docs: https://platform.claude.com/docs/en/about-claude/models/overview
- OpenAI models docs: https://developers.openai.com/api/docs/models/all
- OpenAI deprecations: https://developers.openai.com/api/docs/deprecations
