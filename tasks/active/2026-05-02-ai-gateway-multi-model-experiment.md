# AI Gateway Multi-Model Tool-Call Experiment

## Problem Statement

SAM needs concrete evidence that multi-model tool calling works through Cloudflare AI Gateway's Unified API before building the SAM-native agent harness. The existing AI proxy infrastructure routes through provider-specific paths with client-side format translation. The Unified API (`/compat/chat/completions`) promises server-side translation, which would simplify the harness significantly.

This task produces:
1. A model registry with capability profiles (extending the existing `PLATFORM_AI_MODELS`)
2. An isolated experiment proving tool-call loops through the Unified API
3. Evidence categorizing success/failure by model and failure type

## Research Findings

### Existing Infrastructure
- `packages/shared/src/constants/ai-services.ts`: Has `PLATFORM_AI_MODELS` with id, label, provider, tier, costs — but no tool-call support, context limits, intended roles, or fallback groups
- `apps/api/src/routes/ai-proxy.ts`: Routes to Workers AI / Anthropic / OpenAI via per-provider Gateway paths
- `apps/api/src/services/ai-anthropic-translate.ts`: Full OpenAI↔Anthropic format translation (would be bypassed by Unified API)
- `apps/api/src/services/ai-billing.ts`: Unified Billing via `cf-aig-authorization` header
- `apps/api/src/services/ai-proxy-shared.ts`: Auth, metadata, URL builders
- AI Gateway Unified API: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions` — accepts OpenAI format for ALL providers

### Key Insight
The Unified API means the harness only needs ONE client format (OpenAI chat completions with tools). Gateway handles Anthropic/OpenAI/Workers AI translation. This eliminates `ai-anthropic-translate.ts` for new harness work.

### Models to Test (from research doc 04)
1. **Anthropic**: `claude-sonnet-4-6` — via `anthropic/claude-sonnet-4-6` in Unified API
2. **OpenAI**: `gpt-4.1` — via `openai/gpt-4.1` in Unified API
3. **Workers AI**: `@cf/qwen/qwen2.5-coder-32b-instruct` — may need Workers AI path, not Unified API

## Implementation Checklist

- [ ] 1. Extend model registry in `packages/shared/src/constants/ai-services.ts`:
  - Add `contextWindow`, `toolCallSupport`, `intendedRole`, `fallbackGroup`, `allowedScopes` fields to `PlatformAIModel`
  - Add `unifiedApiModelId` field for Unified API model identifiers (e.g., `anthropic/claude-sonnet-4-6`)
  - Populate existing models with the new fields
  - Add Workers AI coding models (Qwen2.5-Coder-32B, Qwen3-30B-A3B)
- [ ] 2. Create experiment module at `packages/shared/src/constants/ai-gateway-experiment.ts`:
  - Define tool definitions for two test tools (get_weather, calculate)
  - Define expected request/response shapes for the Unified API
  - Document the Unified API endpoint pattern
- [ ] 3. Create local mock test in `packages/shared/tests/unit/ai-model-registry.test.ts`:
  - Validate registry integrity (all models have required fields)
  - Validate Unified API model ID format (provider/model-id)
  - Validate fallback group consistency
  - Validate tool-call support tiers
- [ ] 4. Create experiment script at `experiments/ai-gateway-tool-call/`:
  - `experiment.ts`: Standalone script that calls Unified API with tool definitions
  - Proves a two-tool loop: model calls tool A, gets result, calls tool B, gets final answer
  - Tests one Anthropic model, one OpenAI model, one Workers AI model
  - Categorizes failures: credential/config, provider/model unsupported, tool-call shape mismatch, model quality
  - Captures request/response shapes for documentation
- [ ] 5. Create staging integration test (clearly labeled, network-required):
  - Uses `CF_ACCOUNT_ID` and `CF_API_TOKEN` from env
  - Calls real Unified API endpoint
  - Documents results with exact model IDs and response shapes
- [ ] 6. Document cost-attribution metadata plan:
  - How `cf-aig-metadata` flows through Unified API
  - Alignment with existing SAM billing/usage architecture
  - Any changes needed for harness-specific attribution
- [ ] 7. Write findings document with:
  - Exact model IDs tested and their Unified API identifiers
  - Request/response shape summary per model
  - Tool-call reliability assessment per model
  - Model registry recommendation for harness Phase 1

## Acceptance Criteria

- [ ] Model registry extended with tool-call support, context limits, roles, fallback groups
- [ ] At least one local/mock evaluation exists that validates registry integrity
- [ ] At least one real AI Gateway tool-call test is attempted or clearly blocked by verified missing credentials
- [ ] PR includes exact model IDs tested, request/response shape summary, logs/metadata evidence
- [ ] PR includes model registry recommendation for harness
- [ ] Cost-attribution metadata plan documented and aligned with existing SAM billing

## References

- Parent idea: 01KQM8JT6CPHGS16Y91XJF67FS
- Research docs: `/research/agent-harness/04-multi-model-ai-gateway.md`, `05-sam-architecture-gaps.md`, `08-recommendation-and-action-plan.md`
- Task ID: 01KQMAB5C7ZMP7P4NW2X811GQW
