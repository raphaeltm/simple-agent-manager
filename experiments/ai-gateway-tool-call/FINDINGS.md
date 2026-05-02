# AI Gateway Multi-Model Tool-Call Experiment: Findings

**Date**: 2026-05-02
**Branch**: `sam/execute-task-using-skill-01kqma`

## Summary

This experiment validates multi-model tool calling through Cloudflare AI Gateway for SAM's native harness. Three provider paths were tested: Anthropic (via Unified API), OpenAI (via Unified API), and Workers AI (via dedicated path).

**Key result**: Workers AI (Qwen 2.5 Coder 32B) successfully completed a two-tool loop (`get_weather` -> `calculate`) with structured `tool_calls` responses through AI Gateway, proving the concept is viable for SAM's cost-free tier.

## Models Tested

| Model | Provider | Path | Tool-Call Support | Two-Tool Loop |
|-------|----------|------|-------------------|---------------|
| `claude-haiku-4-5-20251001` | Anthropic | Unified API (`/compat/chat/completions`) | Excellent | Blocked (credential) |
| `gpt-4.1-mini` | OpenAI | Unified API (`/compat/chat/completions`) | Excellent | Blocked (credential) |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | Workers AI | Workers AI path (`/workers-ai/v1/chat/completions`) | Good (with workarounds) | PASS |

## Detailed Findings

### Workers AI: Qwen 2.5 Coder 32B (PASS)

Successfully completed the two-tool loop via manual curl testing through AI Gateway.

**Flow proven**:
1. User asks: "What's the weather in Paris? Tell me the temperature in Celsius."
2. Model returns structured `tool_calls`: `get_weather({city: "Paris"})`
3. Tool result provided: `{temperature_f: 72, condition: "sunny"}`
4. Model returns structured `tool_calls`: `calculate({expression: "(72 - 32) * 5/9"})`
5. Tool result provided: `{result: 22.2222}`
6. Model produces final text answer with both Fahrenheit and Celsius

**Workarounds required**:
- `tool_choice: "required"` must be used instead of `"auto"` for reliable structured `tool_calls` output. With `"auto"`, the model often outputs tool calls as text content instead of structured `tool_calls` array.
- `content: null` in assistant messages with `tool_calls` must be replaced with `content: ""` (empty string). Workers AI rejects null content with a schema validation error: `"Type mismatch of '/messages/2/content', 'string' not in 'null'"`.

**Gateway endpoint**: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/workers-ai/v1/chat/completions`

**Auth**: `Authorization: Bearer {CF_API_TOKEN}` (standard Cloudflare API token — no Unified Billing needed for Workers AI)

### Anthropic: Claude Haiku 4.5 (Blocked — Credential)

The Unified API endpoint correctly routes to Anthropic and returns a provider-specific 401 error, confirming the gateway routing works. The failure is purely credential-based: the staging `CF_TOKEN` does not have Unified Billing authorization scope.

**Gateway endpoint**: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions`

**What worked**: Gateway accepted the request, identified the provider from the `anthropic/` model prefix, and forwarded it. The 401 response came from Anthropic's backend (not the gateway), proving the routing pipeline is functional.

**What's needed**: A `CF_AIG_TOKEN` with Unified Billing scope, or a direct Anthropic API key in the `Authorization` header (bypassing Unified Billing).

### OpenAI: GPT-4.1 Mini (Blocked — Credential)

Same situation as Anthropic — gateway routing works, credential scope insufficient.

## Cost-Attribution Metadata Plan

### Current SAM Approach

SAM already injects `cf-aig-metadata` on all AI proxy requests (see `apps/api/src/services/ai-proxy-shared.ts:buildAIGatewayMetadata()`). The metadata is limited to 5 entries per Cloudflare's constraint:

```json
{
  "userId": "<user-id>",
  "workspaceId": "<workspace-id>",
  "projectId": "<project-id>",
  "source": "<request-source>",
  "modelId": "<model-id>"
}
```

### Alignment for Multi-Model Harness

The existing metadata schema works unchanged for multi-model tool calling. Each request through AI Gateway carries the same 5 metadata fields. The `modelId` field naturally captures which model handled each request, enabling per-model cost attribution in the existing analytics pipeline.

**For the harness specifically**:
- `source` should be set to the agent type (e.g., `workspace-agent`, `sam-agent`, `project-agent`) to distinguish cost centers
- `modelId` captures the actual model used, enabling model-level cost breakdowns
- No changes needed to the existing `cf-aig-metadata` format or the `ai-gateway-logs.ts` aggregation service

### Cost Breakdown by Provider Path

| Path | Billing | Cost |
|------|---------|------|
| Workers AI | Free (included in Workers plan) | $0 |
| Unified API (Anthropic) | Via `cf-aig-authorization` (Unified Billing) or direct API key | Standard Anthropic pricing |
| Unified API (OpenAI) | Via `cf-aig-authorization` (Unified Billing) or direct API key | Standard OpenAI pricing |

Workers AI models are the only zero-cost path. For SAM's free tier, routing all tool-call work through Workers AI models avoids per-token costs entirely.

## Model Registry Additions

The `PLATFORM_AI_MODELS` registry in `packages/shared/src/constants/ai-services.ts` was extended with 6 new fields per model:

| Field | Type | Purpose |
|-------|------|---------|
| `contextWindow` | `number` | Context window size in tokens |
| `toolCallSupport` | `'excellent' \| 'good' \| 'limited' \| 'none'` | Structured tool-call capability |
| `intendedRole` | `'workspace-agent' \| 'sam-agent' \| 'project-agent' \| 'utility' \| 'any'` | Primary use case |
| `fallbackGroup` | `string` | Provider-scoped fallback group for model substitution |
| `allowedScopes` | `ModelAllowedScope[]` | Where the model can be used (workspace, project, top-level) |
| `unifiedApiModelId` | `string \| null` | AI Gateway Unified API model identifier (`provider/model-id`) |

### New Model Added

`@cf/qwen/qwen2.5-coder-32b-instruct` — Workers AI model with 32K context, good tool-call support, and zero cost. Recommended as the primary free-tier model for tool-calling workloads.

## Recommendations for SAM Harness

1. **Use Workers AI path for free-tier tool calling**. The Unified API (`/compat/chat/completions`) does not support Workers AI models — they must use the dedicated `/workers-ai/v1/chat/completions` path.

2. **Apply Workers AI workarounds in the proxy layer**, not in calling agents:
   - Normalize `content: null` → `""` in assistant messages before forwarding to Workers AI
   - Use `tool_choice: "required"` when the harness expects structured tool calls from Workers AI models
   - These workarounds should live in `ai-proxy.ts` or a new `ai-workers-normalize.ts` module

3. **Use `unifiedApiModelId` for routing decisions**:
   - `null` → route via Workers AI path
   - Non-null → route via Unified API `/compat/chat/completions`

4. **Keep `cf-aig-metadata` unchanged**. The existing 5-field schema covers all cost-attribution needs for multi-model scenarios.

5. **Add `toolCallSupport` to model selection logic**. When the harness needs tool calling, filter to models with `excellent` or `good` support. Workers AI models with `limited` or `none` should be excluded from tool-calling flows.

## Request/Response Shapes

### Workers AI Tool Call Request (Working)

```json
{
  "model": "@cf/qwen/qwen2.5-coder-32b-instruct",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant..."},
    {"role": "user", "content": "What is the weather in Paris?"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
      }
    }
  ],
  "tool_choice": "required"
}
```

### Workers AI Tool Call Response (Structured)

```json
{
  "id": "id-1777725417660",
  "object": "chat.completion",
  "model": "@cf/qwen/qwen2.5-coder-32b-instruct",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "chatcmpl-tool-82bae9405b504f75a7fa3a212e857225",
        "type": "function",
        "function": {
          "name": "calculate",
          "arguments": "{\"expression\": \"(72 - 32) * 5/9\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": {"prompt_tokens": 286, "completion_tokens": 29, "total_tokens": 315}
}
```

## Failure Categorization

| Category | Description | Models Affected |
|----------|-------------|-----------------|
| `credential-config` | Auth token lacks required scope (Unified Billing, provider API key) | Claude Haiku 4.5, GPT-4.1 Mini |
| `provider-unsupported` | Model/provider not available through the gateway path | None |
| `tool-call-shape-mismatch` | Response lacks structured `tool_calls` or has invalid format | None (after workarounds) |
| `model-quality` | Model doesn't reliably produce tool calls even with correct format | Workers AI with `tool_choice: "auto"` |
| `network-error` | Connection/timeout failure | None |
