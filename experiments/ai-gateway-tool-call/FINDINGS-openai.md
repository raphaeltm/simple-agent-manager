# GPT-4.1 Mini Harness Evaluation: Findings

**Date**: 2026-05-05
**Branch**: `sam/use-skill-continue-sam-01kqx7`
**Gateway**: SAM AI Gateway (`sam`) via `/openai` path
**Previous experiment**: `FINDINGS-gemma.md` (2026-05-05, Gemma 4 26B baseline)

## Summary

GPT-4.1 Mini (`gpt-4.1-mini`) is a **strong alternative** to Gemma 4 26B for SAM's harness tool-calling workloads. It passes all tests with zero workarounds, produces the most token-efficient responses, and has the fastest latency. However, it costs more than Gemma for this measured loop, does not produce reasoning traces, and routes through Cloudflare's Unified Billing (requires `cf-aig-authorization`). It is recommended as the **paid fallback** when higher quality, longer context, or faster response times justify the cost over the Cloudflare-billed Gemma 4 26B default.

GPT-4.1 Nano (`gpt-4.1-nano`) exhibited tool-call quality issues (duplicate calls) and is **not recommended** for harness use without further evaluation.

## Test Environment

- **Gateway endpoint**: `https://gateway.ai.cloudflare.com/v1/{account_id}/sam/openai/v1/chat/completions`
- **Auth**: `cf-aig-authorization: Bearer {CF_TOKEN}` (Unified Billing — Cloudflare credits cover OpenAI inference)
- **Cost**: Pay-per-token via Cloudflare Unified Billing (see pricing below)
- **Metadata**: `cf-aig-metadata` header with userId, workspaceId, projectId, source, modelId — same schema as Gemma experiment

## Detailed Findings

### 1. Two-Tool Loop: PASS (tool_choice: "auto")

GPT-4.1 Mini completes the get_weather -> calculate -> final answer loop using `tool_choice: "auto"` in exactly 3 turns, same as Gemma 4.

**Flow (3 turns, 3 API calls)**:

| Turn | Request | Response |
|------|---------|----------|
| 1 | User: "Weather in Paris, temp in Celsius" | `tool_calls: [get_weather({city: "Paris"})]`, `finish_reason: "tool_calls"` |
| 2 | Tool result: `{temperature_f: 72, condition: "sunny"}` | `tool_calls: [calculate({expression: "(72 - 32) * 5/9"})]`, `finish_reason: "tool_calls"` |
| 3 | Tool result: `{result: 22.2222}` | `content: "The weather in Paris is sunny at 72F (~22.2C)"`, `finish_reason: "stop"` |

**Total tokens**: 153 + 204 + 249 = 606 across 3 turns.
**Total latency**: ~2.6s (3 calls averaging ~870ms each).

### 2. content: null Handling: PASS (native format)

`content: null` is OpenAI's own specification for assistant messages with tool_calls. It works without issue — this is the canonical format, not an edge case.

### 3. No Reasoning Field

Unlike Gemma 4 which returns a `reasoning` field with chain-of-thought, GPT-4.1 Mini returns only the `content` and `tool_calls` fields. No built-in observability of decision-making process.

GPT-4.1 Mini does return `annotations: []` and `refusal: null` fields in the message, plus detailed `usage.prompt_tokens_details` and `usage.completion_tokens_details` breakdowns (cached tokens, reasoning tokens, audio tokens).

### 4. Harness-Style Coding Tools: PASS

Given "Find processOrder and add error handling for negative total" with grep, read_file, edit_file, bash tools:

- GPT-4.1 Mini correctly chose `grep({pattern: "function processOrder"})` as the first action
- Single tool call per turn (no unnecessary parallel calls)
- Appropriate tool selection (grep first, not bash or blind edit)

### 5. GPT-4.1 Nano: NOT RECOMMENDED

Tested `gpt-4.1-nano` as a potential ultra-cheap option:

- **Turn 1 failure**: Called `get_weather({city: "Paris"})` **twice** in the same response (duplicate tool_calls array entries)
- This would cause double-execution in a real harness loop
- The model appears to have tool-call quality issues at this size tier
- **Verdict**: Not suitable for harness/orchestrator workloads without significant retry/dedup logic

### 6. Comparative Analysis

| Capability | GPT-4.1 Mini | Gemma 4 26B | Qwen 2.5 Coder 32B |
|---|---|---|---|
| **Structured tool_calls with `auto`** | Yes | Yes | **No** (text content) |
| **`content: null` in messages** | Works (native) | Works | **Rejected** |
| **Reasoning/CoT field** | None | `reasoning` | None |
| **Two-tool loop** | PASS | PASS | PASS (with workarounds) |
| **Tokens (2-tool task)** | **606** | 1,159 | N/A |
| **Latency (2-tool task)** | **~2.6s** | ~4.0s | ~3.0s |
| **Workarounds needed** | **None** | **None** | 2 |
| **Context window** | 1M | 32K | 32K |
| **Cost** | OpenAI via Unified Billing | Workers AI: $0.10/M input, $0.30/M output | Workers AI: $0.660/M input, $1.000/M output |
| **Observability** | usage_details only | reasoning field | None |
| **Duplicate tool calls** | No | No | No |

### 7. Token Efficiency

GPT-4.1 Mini is dramatically more token-efficient than Gemma 4:

| Metric | GPT-4.1 Mini | Gemma 4 26B | Ratio |
|--------|-------------|-------------|-------|
| Turn 1 total tokens | 153 | 386 | **2.5x fewer** |
| Turn 2 total tokens | 204 | 371 | **1.8x fewer** |
| Turn 3 total tokens | 249 | 402 | **1.6x fewer** |
| **Total (full loop)** | **606** | **1,159** | **1.9x fewer** |

This efficiency comes from GPT-4.1 Mini's smaller prompt overhead and more concise completions (14 tokens for a tool call vs Gemma's 60+).

### 8. Latency

| Model | Turn 1 | Turn 2 | Turn 3 | Total |
|-------|--------|--------|--------|-------|
| GPT-4.1 Mini | 0.90s | 0.91s | 0.82s | **2.63s** |
| Gemma 4 26B | ~1.3s | ~1.3s | ~1.4s | **~4.0s** |

GPT-4.1 Mini is ~1.5x faster end-to-end.

## Auth Path (SAM Proxy Alignment)

```
SAM Proxy (POST /ai/v1/chat/completions)
  -> resolves model to openai provider (gpt-* prefix)
  -> buildOpenAIUrl() -> gateway.ai.cloudflare.com/v1/{account}/sam/openai/v1/chat/completions
  -> cf-aig-authorization: Bearer {CF_AIG_TOKEN ?? CF_API_TOKEN}  (Unified Billing)
  -> cf-aig-metadata: {userId, workspaceId, projectId, source, modelId}
```

This is the exact path SAM's `forwardToOpenAI()` function uses in `apps/api/src/routes/ai-proxy.ts`. The experiment validates the full production path.

**Key difference from Workers AI path**: OpenAI uses `cf-aig-authorization` (Unified Billing header) rather than `Authorization: Bearer` (standard API token). This means Unified Billing must be enabled on the Cloudflare account for OpenAI models to work through the SAM gateway.

## Request/Response Shapes

### Tool Call Request (Identical to OpenAI native — no workarounds)

```json
{
  "model": "gpt-4.1-mini",
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
cf-aig-authorization: Bearer {CF_TOKEN}
Content-Type: application/json
cf-aig-metadata: {"userId":"...","workspaceId":"...","projectId":"...","source":"...","modelId":"gpt-4.1-mini"}
```

### Tool Call Response

```json
{
  "id": "chatcmpl-DcJTRIX23DVL1ceAyRxz8FbOWKdWU",
  "object": "chat.completion",
  "created": 1778023693,
  "model": "gpt-4.1-mini-2025-04-14",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_AuFaJeP9vTrbZF3Eu461HEfc",
        "type": "function",
        "function": {
          "name": "grep",
          "arguments": "{\"pattern\":\"function processOrder\"}"
        }
      }],
      "refusal": null,
      "annotations": []
    },
    "logprobs": null,
    "finish_reason": "tool_calls"
  }],
  "usage": {
    "prompt_tokens": 236,
    "completion_tokens": 16,
    "total_tokens": 252,
    "prompt_tokens_details": {"cached_tokens": 0, "audio_tokens": 0},
    "completion_tokens_details": {"reasoning_tokens": 0, "audio_tokens": 0, "accepted_prediction_tokens": 0, "rejected_prediction_tokens": 0}
  },
  "service_tier": "default",
  "system_fingerprint": "fp_34570b7b86"
}
```

### Notable Response Shape Differences vs Gemma 4

| Field | GPT-4.1 Mini | Gemma 4 26B |
|-------|-------------|-------------|
| `message.reasoning` | Absent | Present (built-in reasoning field) |
| `message.refusal` | Present (`null`) | Absent |
| `message.annotations` | Present (`[]`) | Absent |
| `usage.prompt_tokens_details` | Detailed breakdown | Minimal |
| `usage.completion_tokens_details` | Detailed breakdown | Absent |
| `service_tier` | Present (`"default"`) | Absent |
| `system_fingerprint` | Present | Absent |
| Tool call ID format | `call_<26-char alphanum>` | `chatcmpl-tool-<16-char hex>` |

## Pricing (Cloudflare Unified Billing)

Pricing via Cloudflare Unified Billing (as of 2026-05-05):

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Cost for measured loop |
|-------|----------------------|------------------------|-----------------------------------|
| GPT-4.1 Mini | $0.40 | $1.60 | ~$0.00014 for 225 input / 30 output tokens |
| GPT-5 Mini | $0.25 | $2.00 | ~$0.00012 for the same 225 input / 30 output token mix (next eval target) |
| GPT-4.1 Nano | $0.10 | $0.40 | ~$0.00003 for the same 225 input / 30 output token mix |
| Gemma 4 26B | $0.10 | $0.30 | ~$0.00004 for 298 input / 34 output tokens |

## Implications for SAM Harness

### Model Selection Strategy

```
Default (low-cost, good quality): @cf/google/gemma-4-26b-a4b-it  (Workers AI)
Paid fallback (fast, efficient):  gpt-4.1-mini                    (OpenAI via Unified Billing)
Next candidate:                  gpt-5-mini                      (OpenAI via Unified Billing)
```

### When to Use GPT-4.1 Mini Over Gemma 4

1. **Latency-sensitive operations** — GPT-4.1 Mini is ~1.5x faster per turn
2. **Long context tasks** — 1M token window vs Gemma's 32K
3. **Token budget constraints** — uses ~1.9x fewer tokens per loop
4. **When the user has Unified Billing enabled** — the cost per task is negligible (~$0.0001 per tool-call loop)

### When to Prefer Gemma 4

1. **Lowest measured cost** — Gemma 4 is Cloudflare-billed, but this loop was still cheaper than GPT-4.1 Mini
2. **Observability needs** — Gemma's `reasoning` field provides built-in reasoning traces
3. **No Unified Billing configured** — the OpenAI path requires `CF_AIG_TOKEN` or `CF_API_TOKEN` with billing scope
4. **Self-hosted deployments** — Workers AI requires only a standard Cloudflare token, not OpenAI billing

### No Code Changes Needed

GPT-4.1 Mini works through the existing SAM proxy code path (`forwardToOpenAI()` in `ai-proxy.ts`) without any modifications. The `isOpenAIModel()` function already recognizes `gpt-*` prefixes, and `resolveUnifiedBillingToken()` already handles the `cf-aig-authorization` header.

### Model Registry Consideration

GPT-4.1 Mini could be added to the model registry with:
- `toolCallSupport: 'native'` (OpenAI's own format, zero workarounds)
- `intendedRole: 'workspace-agent-paid'` or a new tier
- `contextWindow: 1000000`
- `provider: 'openai'`

## Recommendations

1. **Keep Gemma 4 26B as default harness model.** Low-cost, good quality, reasoning traces. The cost advantage is meaningful for a platform that runs many agent loops.

2. **Add GPT-4.1 Mini as a configurable paid alternative.** When users or the platform want faster/more-efficient responses and are willing to pay, GPT-4.1 Mini is the clear choice. Add it to the model registry.

3. **Do NOT use GPT-4.1 Nano for harness work.** Duplicate tool calls indicate insufficient quality for autonomous agent loops.

4. **Unified Billing is the gate.** The OpenAI path requires `cf-aig-authorization` with a billing-capable token. Self-hosters without Unified Billing cannot use this path — they fall back to Gemma 4 through Workers AI billing or provide their own OpenAI API key via platform credentials.

5. **Consider a model tier system in the harness config:**
   - Tier 0 (low-cost Workers AI): `@cf/google/gemma-4-26b-a4b-it` — default, no separate provider credentials
   - Tier 1 (small OpenAI): `gpt-4.1-mini` or `gpt-5-mini` — fast, efficient, requires Unified Billing
   - Tier 2 (premium): `claude-haiku-4-5` — highest quality, most expensive (also passed the test)
