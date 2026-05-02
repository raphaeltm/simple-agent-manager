# Multi-Model Support via Cloudflare AI Gateway

**Date:** 2026-05-02

## Executive Summary

Cloudflare AI Gateway supports 70+ models from 13+ providers through two API access patterns. The **Unified API** (`/compat/chat/completions`) is the key finding: it accepts OpenAI-format requests for ALL providers and handles format translation server-side — meaning SAM's harness does not need to implement Anthropic vs OpenAI tool-calling format differences itself. SAM already routes through AI Gateway for usage tracking and has most of the plumbing in place.

## CF AI Gateway API Access Patterns

### Pattern A: Unified API (Recommended for Agent Harness)

The Unified API uses OpenAI `/chat/completions` format for ALL providers. AI Gateway translates to native provider format server-side.

```
Endpoint: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions
```

Models specified as `{provider}/{model}`:
- `anthropic/claude-4-6-sonnet`
- `openai/gpt-4o`
- `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`

**Critical insight:** Tool calling passes through in OpenAI format — the gateway translates to/from Anthropic's native tool format automatically. This means `ai-anthropic-translate.ts` in SAM becomes redundant for new agent work flowing through the Unified API.

### Pattern B: Universal Endpoint (Fallback Chains)

Accepts an array of provider configs for fallback/retry:

```
Endpoint: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}
```

Each entry specifies `provider`, `endpoint`, `headers`, and native-format `query`. Best for: first try provider A, fall back to provider B.

### Key Features (Both Patterns)
- **Unified Billing** — pay via Cloudflare credits, no per-provider API keys needed
- **Per-request metadata** (`cf-aig-metadata`) for cost attribution
- Caching, rate limiting, logging via dashboard
- Dynamic routing rules (percentage splits, conditional routing)

## Providers and Key Models

**Supported Providers (13+):** Anthropic, OpenAI, Google AI Studio, Google Vertex AI, xAI (Grok), Groq, Mistral, Cohere, Perplexity, DeepSeek, Cerebras, Replicate, Cloudflare Workers AI.

### Tier 1: Frontier Coding Models (Optimize Prompts for These)

| Model | Provider | SWE-bench | Context | Tool Calling | Use Case |
|-------|----------|-----------|---------|-------------|----------|
| **Claude 4.6 Sonnet** | Anthropic | 79.6% | 200k | Native, excellent | Default for workspace agents |
| **Claude 4.6 Opus** | Anthropic | 80.8% | 200k | Native, excellent | Complex tasks, SAM agent |
| **GPT-5.4** | OpenAI | ~75% (Terminal-Bench) | 128k | Native, excellent | Alternative/fallback |
| **Claude 4.5 Haiku** | Anthropic | -- | 200k | Native, good | Quick completions, classification |

### Tier 2: Strong Open-Weight Models

| Model | Provider | SWE-bench | Context | Tool Calling | CF Workers AI? | Use Case |
|-------|----------|-----------|---------|-------------|----------------|----------|
| **Kimi K2.5** | Workers AI | 76.8% | 256k | Yes (multi-turn) | Yes | Highest open-source SWE-bench |
| **Qwen2.5-Coder-32B** | Workers AI / Groq | ~68% | 128k | Yes (Hermes-style) | Yes (`@cf/qwen/qwen2.5-coder-32b-instruct`) | Best coding-specific open model |
| **Qwen3-30B-A3B** | Workers AI | Good | 32k | Yes | Yes (`@cf/qwen/qwen3-30b-a3b-fp8`) | MoE model, efficient inference |
| **o4-mini** | OpenAI | Good | 128k | Native | No | Reasoning-heavy planning |

### Tier 3: Specialized / Cost-Efficient

| Model | Provider | Context | Tool Calling | Notes |
|-------|----------|---------|-------------|-------|
| **DeepSeek R1** | Groq | 128k | Partial | Excellent reasoning, weak tool chains |
| **Llama 3.3 70B** | Groq / Workers AI | 128k | Limited native | Better with XML-based approach |
| **Gemini 2.5 Pro** | Google | 1M tokens | Yes | Long context specialist |

## Tool Calling Compatibility Matrix

| Model | Format | Reliability | Agent Loop Fit |
|-------|--------|-------------|---------------|
| Claude Opus/Sonnet 4.6 | Native Anthropic tool_use | Excellent | Full agent loop |
| GPT-5.4 / o4-mini | Native OpenAI function calling | Excellent | Full agent loop |
| Kimi K2.5 | OpenAI-compatible | Good | Full agent loop |
| Qwen2.5-Coder-32B | Hermes-style (OpenAI-compat) | Good | Full agent loop |
| Qwen3-30B-A3B | OpenAI-compatible | Good | Full agent loop |
| Mistral Small 3.1 24B | Native function calling | Moderate | Simple tool chains only |
| Llama 3.3 70B | Limited native | Weak | Code gen only, not agent loop |
| DeepSeek-R1-Distill-32B | Partial | Moderate | Simple cases only |
| Hermes 2 Pro Mistral 7B | Hermes format | Moderate | Smallest with tool calling fine-tuning |

**Practical recommendation:** For a coding agent, stick to models with reliable native tool calling (Claude, GPT, Kimi, Qwen2.5-Coder, Qwen3). XML fallback works but degrades agent loop reliability — tool-call parsing errors become a major source of agent failures. Models with weak tool calling are better as code-generation backends, not full agent loop participants.

### Fallback Strategies for Weak Tool Calling Models

1. **XML-based tool calling** — inject tool definitions as XML in system prompt, parse `<tool_call>` blocks from output (how early Claude Code worked)
2. **Structured output constraint** — use Workers AI JSON schema output mode to force tool-call-shaped JSON
3. **Two-pass approach** — use the model for reasoning/code gen, delegate tool-calling decisions to a smaller tool-calling-capable model (e.g., Hermes 2 Pro 7B as "tool router")

## Vercel AI SDK Integration

### Current State in SAM

SAM uses `workers-ai-provider` (v3.0.0, AI SDK v6) via `createWorkersAI({ binding: env.AI })` for internal tasks (title gen, TTS, summarization). This only accesses Workers AI models.

### For Multi-Model: Two Provider Packages

**`workers-ai-provider`** — for models running on Workers AI infrastructure:
```typescript
const workersAi = createWorkersAI({ binding: env.AI });
const model = workersAi('@cf/qwen/qwen2.5-coder-32b-instruct');
```

**`ai-gateway-provider`** — for routing through AI Gateway to any external provider:
```typescript
import { aigateway } from 'ai-gateway-provider';
const model = aigateway([
  anthropic('claude-4-6-sonnet'),  // primary
  openai('gpt-5.4'),               // fallback
]);
```

Note: Workers AI is NOT listed among `ai-gateway-provider`'s supported providers. You need BOTH providers: `ai-gateway-provider` for external models and `workers-ai-provider` for Workers AI models.

### Runtime Model Switching Pattern

```typescript
function getModel(modelId: string) {
  if (modelId.startsWith('@cf/')) {
    return workersAi(modelId);           // Workers AI binding
  } else {
    return aigateway([{ provider: modelId }]); // AI Gateway
  }
}
// Usage: await generateText({ model: getModel(selectedModel), tools, prompt })
```

**Alternative:** Bypass the SDK and call the AI Gateway Unified API directly via fetch (which is what SAM's `ai-proxy.ts` already does). The Vercel AI SDK adds value for streaming and structured output, but for a raw agent loop, direct HTTP to `/compat/chat/completions` may be simpler and more controllable.

## SAM's Existing Plumbing

SAM already has most of the multi-model infrastructure:

| Component | Location | What It Does |
|-----------|----------|-------------|
| AI proxy routes | `apps/api/src/routes/ai-proxy.ts` | Routes to Workers AI, Anthropic, or OpenAI via AI Gateway |
| Format translation | `apps/api/src/services/ai-anthropic-translate.ts` | Full OpenAI-to-Anthropic format translation |
| Billing integration | `apps/api/src/services/ai-billing.ts` | Unified Billing support, upstream auth resolution |
| Rate limiting | AI proxy middleware | Per-user RPM rate limiting + daily token budget |
| Cost attribution | `cf-aig-metadata` header | Per-request metadata for cost tracking |
| Model dispatch | `getModelProvider()` in ai-proxy | Dispatches by model prefix |

**What's still needed:**
1. **Model registry / capability profiles** — map model IDs to capabilities (tool calling support, context window, coding tier)
2. **Prompt adaptation layer** — model-specific prompt templates (frontier models get complex instructions, efficient models get simpler prompts)
3. **Agent profile → model selection** — UI for users to choose models per workspace agent
4. **Fallback chain configuration** — primary model + fallback model per agent profile

## Recommended Harness Architecture

```
Agent Harness (Multi-Model)
  |
  +-- Model Registry
  |     model ID -> capability profile
  |     { supports_tool_calling, max_context, coding_tier, ... }
  |
  +-- Prompt Adapter
  |     adjusts system prompts per model tier
  |     frontier: complex multi-step instructions
  |     efficient: simpler, more explicit prompts
  |
  +-- Tool Format Layer
  |     Use CF AI Gateway Unified API (/compat/chat/completions)
  |     Gateway handles OpenAI <-> Anthropic <-> native translation
  |
  +-- Fallback Chain
  |     Use Universal Endpoint or ai-gateway-provider array syntax
  |     primary model -> fallback model
  |
  +-- Capability-Aware Routing
        Tier 1 (frontier): Full tool calling, extended thinking, 100k+ context
        Tier 2 (strong): Tool calling, good coding, 32k-128k context
        Tier 3 (efficient): Basic completion, limited/no tool calling
```

## Model Selection Strategy for SAM

### For Workspace Agents (User-Configurable)
- Default: Claude 4.6 Sonnet (best coding performance)
- User can select from shortlist in agent profile settings
- Model affects which prompt templates and capability tier are used
- The harness adapts automatically via the Unified API

### For Top-Level SAM Agent (Fixed, Optimized)
- Fixed model: Claude 4.6 Opus or Sonnet
- Heavily optimized prompts for SAM's orchestration patterns
- No user choice — optimized for one model
- Could use Haiku for routine classification/routing

### For Project-Level Agent (Fixed, Optimized)
- Fixed model: Claude 4.6 Sonnet (cost/capability balance)
- Optimized prompts for code analysis, task planning, dispatch
- Could fall back to Haiku for simple queries

## Recommended Starting Shortlist (5 Models)

| Model | Role | Why |
|-------|------|-----|
| **Claude 4.6 Sonnet** | Primary default | Best coding agent, excellent tool calling |
| **Claude 4.6 Opus** | Complex tasks | Highest SWE-bench, for planning/review |
| **GPT-5.4** | Alternative/fallback | Strong terminal/agentic workflows |
| **Qwen2.5-Coder-32B** | Open-weight/cost-efficient | Best coding-specific open model, runs on Workers AI |
| **Kimi K2.5** | Open-weight/high-capability | Highest open-source SWE-bench (76.8%) |

This covers frontier, strong, and efficient tiers while keeping the supported set manageable for prompt optimization and testing.

## Summary

| Concern | Solution |
|---------|----------|
| Multi-model API differences | CF AI Gateway Unified API handles translation server-side |
| Tool calling format variations | Unified API normalizes to OpenAI format; Gateway translates |
| Unified billing | CF AI Gateway handles this |
| Usage tracking | SAM's existing AI proxy infrastructure |
| Go multi-model (VM harness) | Direct HTTP to Unified API endpoint |
| TypeScript multi-model (DO agents) | Vercel AI SDK `ai-gateway-provider` + `workers-ai-provider` |
| Model selection UX | Shortlist of 5 tested models, default per context |
| Prompt optimization | Model-specific prompt templates by capability tier |
| Existing SAM plumbing | AI proxy, format translation, billing — mostly reusable |
