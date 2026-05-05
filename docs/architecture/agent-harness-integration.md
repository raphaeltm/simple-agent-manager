# Agent Harness Integration Architecture

## Overview

SAM's native harness routes LLM requests through the SAM AI proxy to Cloudflare AI Gateway. This document covers the model selection, routing paths, and integration points for harness-driven tool-calling workloads.

## Model Selection for Harness Tool Calling

### Recommended: Gemma 4 26B (`@cf/google/gemma-4-26b-a4b-it`)

Primary model for harness/orchestrator reasoning. Selected based on evaluation (2026-05-05):

- Produces structured `tool_calls` with `tool_choice: "auto"` (no forcing required)
- Handles OpenAI-format `content: null` without workarounds
- Returns built-in `reasoning` field for observability
- Zero cost (Workers AI free tier)
- Official `function_calling=true` in Cloudflare model metadata

### Fallback: Qwen 2.5 Coder 32B (`@cf/qwen/qwen2.5-coder-32b-instruct`)

Requires two workarounds:
1. `tool_choice: "required"` (auto produces text instead of structured tool_calls)
2. `content: null` → `""` normalization (Workers AI schema validation rejects null)

### Alternative: Qwen 3 30B (`@cf/qwen/qwen3-30b-a3b-fp8`)

Works with `tool_choice: "auto"` and returns `reasoning_content`, but uses ~60% more tokens than Gemma 4 for equivalent tasks.

## Routing Architecture

```
Harness Agent Loop
  → POST /ai/v1/chat/completions (SAM API Worker)
    → resolveModelId() → getModelProvider() → 'workers-ai'
    → buildWorkersAIUrl() → gateway.ai.cloudflare.com/v1/{account}/sam/workers-ai/v1/chat/completions
    → Authorization: Bearer {CF_API_TOKEN}
    → cf-aig-metadata: {userId, workspaceId, projectId, source, modelId}
```

For non-Workers AI models (Anthropic, OpenAI) with Unified Billing:
```
  → resolveUpstreamAuth() → cf-aig-authorization: Bearer {CF_AIG_TOKEN}
  → Unified API: gateway.ai.cloudflare.com/v1/{account}/sam/compat/chat/completions
```

## Cost Attribution

All requests carry `cf-aig-metadata` with 5 fields (Cloudflare limit):
- `userId` — user who triggered the task
- `workspaceId` — workspace running the agent
- `projectId` — project context
- `source` — agent type (e.g., `workspace-agent`, `sam-agent`)
- `modelId` — model used for this request

Workers AI models are $0. Unified API (Anthropic/OpenAI) costs follow standard pricing.

## Evaluation Results

See `experiments/ai-gateway-tool-call/FINDINGS.md` (Qwen baseline) and `experiments/ai-gateway-tool-call/FINDINGS-gemma.md` (Gemma evaluation) for detailed test data.
