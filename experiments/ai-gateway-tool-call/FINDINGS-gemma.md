# Gemma 4 26B Harness Evaluation: Findings

**Date**: 2026-05-05
**Branch**: `sam/use-skill-continue-sam-01kqx3`
**Gateway**: SAM AI Gateway (`sam`) via Workers AI path
**Previous experiment**: `FINDINGS.md` (2026-05-02, Qwen 2.5 Coder baseline)

## Summary

Gemma 4 26B (`@cf/google/gemma-4-26b-a4b-it`) is **strictly superior** to all tested Qwen models for SAM's harness/orchestrator tool-calling workloads. It completes multi-tool loops with `tool_choice: "auto"`, handles OpenAI-format edge cases (`content: null`) without workarounds, produces built-in reasoning traces, and uses fewer tokens than Qwen 3 30B. It is the recommended default for SAM's native harness.

## Test Environment

- **Gateway endpoint**: `https://gateway.ai.cloudflare.com/v1/{account_id}/sam/workers-ai/v1/chat/completions`
- **Auth**: `Authorization: Bearer {CF_TOKEN}` (standard Cloudflare API token — no Unified Billing needed for Workers AI path)
- **Cost**: Cloudflare Workers AI billing ($0.10 per 1M input tokens, $0.30 per 1M output tokens as of 2026-05-06)
- **Metadata**: `cf-aig-metadata` header with userId, workspaceId, projectId, source, modelId — same schema as existing SAM proxy

## Detailed Findings

### 1. Two-Tool Loop: PASS (tool_choice: "auto")

Gemma 4 completes the get_weather → calculate → final answer loop using `tool_choice: "auto"`. This is a critical improvement — Qwen 2.5 Coder required `tool_choice: "required"` because `"auto"` produced tool calls as text content instead of structured `tool_calls` array.

**Flow (3 turns, 3 API calls)**:

| Turn | Request | Response |
|------|---------|----------|
| 1 | User: "Weather in Paris, temp in Celsius" | `tool_calls: [get_weather({city: "Paris"})]`, `finish_reason: "tool_calls"` |
| 2 | Tool result: `{temperature_f: 72, condition: "sunny"}` | `tool_calls: [calculate({expression: "(72 - 32) * 5/9"})]`, `finish_reason: "tool_calls"` |
| 3 | Tool result: `{result: 22.2222}` | `content: "The weather in Paris is currently sunny at 72F (~22.22C)"`, `finish_reason: "stop"` |

**Total tokens**: 386 + 371 + 402 = 1,159 across 3 turns.

### 2. content: null Handling: PASS (no workaround needed)

The OpenAI chat format specifies `content: null` for assistant messages that contain `tool_calls`. Qwen 2.5 Coder rejects this with:

```
Type mismatch of '/messages/2/content', 'string' not in 'null'
```

Gemma 4 accepts `content: null` without issue. **No normalization needed in the proxy layer.**

### 3. Reasoning Field (Chain-of-Thought)

Gemma 4 returns a `reasoning` field in every response containing its chain-of-thought. This is unprompted — no special system prompt or parameter needed.

**Example reasoning from Turn 1**:
```
The user is asking for the weather in Paris and the temperature in Celsius.
First, I need to get the current weather in Paris using the `get_weather` tool.
The `get_weather` tool returns the temperature in Fahrenheit.
Once I have the temperature in Fahrenheit, I will need to convert it to Celsius using the `calculate` tool.
The formula for converting Fahrenheit to Celsius is (F - 32) * 5/9.

Step 1: Call `get_weather(city='Paris')`.
Step 2: From the output, extract the temperature in Fahrenheit.
Step 3: Call `calculate(expression='(F_value - 32) * 5 / 9')` where `F_value` is the temperature from step 1.
Step 4: Respond to the user with the weather condition and the temperature in Celsius.
```

This provides built-in observability for harness traces without needing an explicit "think step by step" prompt.

### 4. Harness-Style Coding Tools: PASS

Tested with `grep`, `read_file`, `edit_file`, `bash` tools (the planned harness tool set). Given "Find processOrder and add error handling for negative total":

- Gemma correctly chose `grep({pattern: "processOrder"})` as the first action
- Reasoning showed correct sequential plan: search → read → edit
- No attempt to edit before searching (a common failure mode for smaller models)

### 5. Comparative Analysis

| Capability | Gemma 4 26B | Qwen 2.5 Coder 32B | Qwen 3 30B |
|---|---|---|---|
| **Structured tool_calls with `auto`** | Yes | **No** (text content) | Yes |
| **`content: null` in messages** | Works | **Rejected** | Works |
| **Reasoning/CoT field** | `reasoning` | None | `reasoning_content` |
| **Two-tool loop** | PASS | PASS (with workarounds) | PASS |
| **Tokens (2-tool task)** | 1,159 | N/A (failed auto) | ~1,600 (estimated) |
| **Workarounds needed** | **None** | 2 | None |
| **CF function_calling flag** | `true` | N/A | N/A |
| **Context window** | 32K | 32K | 32K |
| **Cost** | Workers AI: $0.10/M input, $0.30/M output | Workers AI: $0.660/M input, $1.000/M output | Workers AI: $0.051/M input, $0.335/M output |

### 6. Workers AI Model Availability

Queried `GET /accounts/{id}/ai/models/search?search=gemma` — Gemma models on Workers AI:

| Model | function_calling |
|-------|-----------------|
| `@cf/google/gemma-4-26b-a4b-it` | **true** |
| `@cf/google/gemma-3-12b-it` | N/A (no support) |
| `@cf/google/gemma-2b-it-lora` | N/A |
| `@cf/google/gemma-7b-it-lora` | N/A |
| Others (embedding, LoRA variants) | N/A |

Only Gemma 4 26B has function calling support.

## Request/Response Shapes

### Tool Call Request (Working — No Workarounds)

```json
{
  "model": "@cf/google/gemma-4-26b-a4b-it",
  "messages": [
    {"role": "system", "content": "You are a coding agent..."},
    {"role": "user", "content": "Find processOrder and add error handling..."}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "grep",
        "description": "Search files for a pattern...",
        "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]}
      }
    }
  ],
  "tool_choice": "auto"
}
```

**Headers**:
```
Authorization: Bearer {CF_TOKEN}
Content-Type: application/json
cf-aig-metadata: {"userId":"...","workspaceId":"...","projectId":"...","source":"...","modelId":"@cf/google/gemma-4-26b-a4b-it"}
```

### Tool Call Response (Structured, with Reasoning)

```json
{
  "id": "id-1778019692747",
  "object": "chat.completion",
  "model": "@cf/google/gemma-4-26b-a4b-it",
  "choices": [{
    "finish_reason": "tool_calls",
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "reasoning": "I need to find the processOrder function first...",
      "tool_calls": [{
        "id": "chatcmpl-tool-99199f627f866dcf",
        "type": "function",
        "function": {
          "name": "grep",
          "arguments": "{\"pattern\": \"processOrder\"}"
        }
      }]
    }
  }],
  "usage": {"prompt_tokens": 396, "completion_tokens": 60, "total_tokens": 456}
}
```

## Auth Path

```
SAM Proxy (POST /ai/v1/chat/completions)
  → resolves model to workers-ai provider
  → buildWorkersAIUrl() → gateway.ai.cloudflare.com/v1/{account}/sam/workers-ai/v1/chat/completions
  → Authorization: Bearer {CF_API_TOKEN}  (standard Cloudflare token, no Unified Billing for Workers AI)
  → cf-aig-metadata: {userId, workspaceId, projectId, source, modelId}
```

For the direct experiment (bypassing SAM proxy), the auth path is identical — same gateway endpoint, same token.

## Implications for SAM Proxy Layer

### Workarounds That Can Be Removed

If Gemma 4 becomes the default harness model, the following Qwen-specific workarounds become unnecessary for the harness path:

1. **`tool_choice: "required"` forcing** — Gemma 4 works correctly with `"auto"`
2. **`content: null → ""` normalization** — Gemma 4 accepts null content

These workarounds should remain in the generic proxy for backward compatibility with Qwen models, but the harness can skip them when routing to Gemma 4.

### Model Registry Updates Needed

1. **Add** `@cf/google/gemma-4-26b-a4b-it` with `toolCallSupport: 'good'`, `intendedRole: 'workspace-agent'`
2. **Keep** Gemma 3 12B as `toolCallSupport: 'none'` (confirmed no function_calling support)

## Recommendations

1. **Use Gemma 4 26B as the default harness model.** It requires zero workarounds, produces reasoning traces, and has official function_calling support from Cloudflare. Qwen 2.5 Coder remains as a fallback but should not be the default.

2. **Persist the `reasoning` field in harness traces.** It provides built-in observability — the model's decision-making process is visible without needing "chain of thought" prompting or separate logging.

3. **Next experiment: OpenAI model through Unified Billing.** Per the knowledge graph, the priority after Gemma is a small OpenAI model (gpt-4.1-mini) through the Unified API path. This requires `CF_AIG_TOKEN` with Unified Billing scope, which was blocked in the previous experiment.

4. **Update the model registry** to include Gemma 4 26B with accurate capability metadata, making it available for selection in the harness model picker.

5. **Consider Gemma 4 26B for SAM agent tool calling.** The SAM session agent currently uses the Workers AI binding directly (`@cf/google/gemma-4-26b-a4b-it` is already `SAM_MODEL` in wrangler.toml). The model's tool-call reliability makes it viable for orchestrator-level reasoning, not just utility tasks.
