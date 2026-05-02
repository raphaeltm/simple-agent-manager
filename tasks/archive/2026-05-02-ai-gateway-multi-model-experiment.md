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
- `apps/api/src/services/ai-anthropic-translate.ts`: Full OpenAI<->Anthropic format translation (would be bypassed by Unified API)
- `apps/api/src/services/ai-billing.ts`: Unified Billing via `cf-aig-authorization` header
- `apps/api/src/services/ai-proxy-shared.ts`: Auth, metadata, URL builders
- AI Gateway Unified API: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions` — accepts OpenAI format for ALL providers

### Key Insight
The Unified API means the harness only needs ONE client format (OpenAI chat completions with tools). Gateway handles Anthropic/OpenAI/Workers AI translation. This eliminates `ai-anthropic-translate.ts` for new harness work.

### Models to Test (from research doc 04)
1. **Anthropic**: `claude-haiku-4-5-20251001` — via `anthropic/claude-haiku-4-5-20251001` in Unified API
2. **OpenAI**: `gpt-4.1-mini` — via `openai/gpt-4.1-mini` in Unified API
3. **Workers AI**: `@cf/qwen/qwen2.5-coder-32b-instruct` — requires Workers AI path, not Unified API

### Workers AI Tool-Call Quirks (Discovered During Experiment)
- `tool_choice: "auto"` causes text output instead of structured `tool_calls` — must use `"required"`
- `content: null` in assistant messages rejected — must use `""` (empty string)
- Workers AI models cannot use Unified API path — must use `/workers-ai/v1/chat/completions`

## Implementation Checklist

- [x] 1. Extend model registry in `packages/shared/src/constants/ai-services.ts`:
  - Added `contextWindow`, `toolCallSupport`, `intendedRole`, `fallbackGroup`, `allowedScopes` fields to `PlatformAIModel`
  - Added `unifiedApiModelId` field for Unified API model identifiers (e.g., `anthropic/claude-sonnet-4-6`)
  - Populated existing models with the new fields
  - Added Workers AI model: `@cf/qwen/qwen2.5-coder-32b-instruct`
- [x] 2. Create experiment module at `experiments/ai-gateway-tool-call/`:
  - Tool definitions for two test tools (get_weather, calculate)
  - Request/response shapes for Unified API and Workers AI paths
  - Documented endpoint patterns
- [x] 3. Create local mock test in `packages/shared/tests/unit/ai-model-registry.test.ts`:
  - 24 tests validating registry integrity, unique IDs, context windows, costs
  - Validates Unified API model ID format (provider/model-id)
  - Validates fallback group consistency (same provider per group)
  - Validates tool-call support tiers and scope constraints
- [x] 4. Create experiment script at `experiments/ai-gateway-tool-call/experiment.ts`:
  - Standalone script that calls AI Gateway with tool definitions
  - Proves a two-tool loop: get_weather -> calculate
  - Tests one Anthropic model, one OpenAI model, one Workers AI model
  - Categorizes failures: credential-config, provider-unsupported, tool-call-shape-mismatch, model-quality
  - Workers AI workarounds: content null -> "", tool_choice "required"
- [x] 5. Manual staging integration test (via curl):
  - Proved two-tool loop on Workers AI through AI Gateway
  - Anthropic/OpenAI correctly blocked by credential scope (not gateway routing)
  - Documented exact model IDs and response shapes
- [x] 6. Document cost-attribution metadata plan:
  - cf-aig-metadata flows unchanged through both Unified API and Workers AI paths
  - Existing 5-field schema (userId, workspaceId, projectId, source, modelId) covers all needs
  - No changes needed for harness-specific attribution
- [x] 7. Write findings document:
  - Exact model IDs tested and their gateway identifiers
  - Request/response shape summary per model (with actual JSON)
  - Tool-call reliability assessment per model
  - Model registry recommendation for harness Phase 1

## Acceptance Criteria

- [x] Model registry extended with tool-call support, context limits, roles, fallback groups
- [x] At least one local/mock evaluation exists that validates registry integrity
- [x] At least one real AI Gateway tool-call test is attempted or clearly blocked by verified missing credentials
- [x] PR includes exact model IDs tested, request/response shape summary, logs/metadata evidence
- [x] PR includes model registry recommendation for harness
- [x] Cost-attribution metadata plan documented and aligned with existing SAM billing

## References

- Parent idea: 01KQM8JT6CPHGS16Y91XJF67FS
- Research docs: `/research/agent-harness/04-multi-model-ai-gateway.md`, `05-sam-architecture-gaps.md`, `08-recommendation-and-action-plan.md`
- Task ID: 01KQMAB5C7ZMP7P4NW2X811GQW
