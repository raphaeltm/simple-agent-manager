# Expanded Model Comparison — 2026-05-10

## Configuration

| Parameter | Value |
|-----------|-------|
| **Endpoint** | Cloudflare AI Gateway (unified billing) |
| **URL** | `https://gateway.ai.cloudflare.com/v1/<account-id>/sam/openai/v1` |
| **Auth** | `cf-aig-authorization: Bearer $CF_TOKEN` |
| **Branch** | `harness/develop` |
| **Date** | 2026-05-10 ~09:00-09:20 UTC |

### Models Tested

| Model | Input $/1M | Output $/1M | Type | Notes |
|-------|-----------|------------|------|-------|
| gpt-4.1-mini | $0.40 | $1.60 | Standard chat | Baseline from prior eval |
| gpt-5-mini | $0.25 | $2.00 | **Reasoning** | Uses reasoning tokens (billed at output rate) |
| gpt-5.4-mini | $0.75 | $4.50 | Standard chat | Most expensive per-token |

### Gemini 2.5 Flash — Not Tested

Gemini 2.5 Flash ($0.30/$2.50) is available through Cloudflare AI Gateway via the `google-ai-studio` provider path, but it uses Google's native API format — **not OpenAI-compatible**. The harness speaks OpenAI chat completions only.

Additionally, **unified billing (`cf-aig-authorization`) only works for the OpenAI provider path**. Google AI Studio requires a separate Google API key in the standard `Authorization` header.

To test Gemini through the harness would require either:
1. Adding a native Gemini provider to the Go harness
2. Using Google AI Studio's OpenAI-compatible endpoint (`/v1beta/openai/`) with a Google API key (bypassing unified billing)

Neither aligns with the goal of routing all traffic through one gateway with unified billing.

---

## Standard Eval Results (5 Tasks)

All models: **5/5 PASS**

### Per-Task Breakdown

| Task | gpt-4.1-mini ||| gpt-5-mini ||| gpt-5.4-mini |||
|------|---|---|---|---|---|---|---|---|---|
| | Turns | Tools | Time | Turns | Tools | Time | Turns | Tools | Time |
| bug-fix | 5 | 4 | 5s | 11 | 10 | 38s | 6 | 8 | 21s |
| multi-file-rename | 4 | 8 | 8s | 15 | 15 | 27s | 6 | 10 | 7s |
| codebase-navigation | 3 | 2 | 3s | 2 | 1 | 4s | 2 | 2 | 2s |
| test-diagnosis | 2 | 2 | 4s | 4 | 3 | 10s | 3 | 4 | 4s |
| refactor-export | 4 | 6 | 6s | 13 | 12 | 32s | 14 | 14 | 16s |
| **Total** | **18** | **22** | **26s** | **45** | **41** | **111s** | **31** | **38** | **50s** |

### Token Usage (Standard Tasks)

| Task | gpt-4.1-mini ||| gpt-5-mini |||| gpt-5.4-mini |||
|------|---|---|---|---|---|---|---|---|---|---|
| | Prompt | Completion | | Prompt | Completion | Reasoning | | Prompt | Completion | |
| bug-fix | 5,214 | 195 | | 16,078 | 1,441 | 832 | | 8,229 | 372 | |
| multi-file-rename | 3,094 | 375 | | 19,750 | 1,050 | 320 | | 10,680 | 574 | |
| codebase-navigation | 1,872 | 41 | | 1,506 | 44 | 0 | | 1,590 | 79 | |
| test-diagnosis | 1,897 | 227 | | 3,760 | 657 | 384 | | 3,014 | 325 | |
| refactor-export | 5,665 | 258 | | 27,394 | 1,538 | 832 | | 31,124 | 807 | |
| **Total** | **17,742** | **1,096** | | **68,488** | **4,730** | **2,368** | | **54,637** | **2,157** | |

---

## Hard Eval Results (3 Tasks)

These tasks require reading 3+ files, cross-referencing data flows, and coordinating changes across multiple packages. Max turns set to 20.

All models: **3/3 PASS**

### Hard Task Descriptions

1. **cross-file-bug**: Diagnose a bug where `CalcTotal(basePrice, discountPct, taxRate)` is called with arguments swapped (`CalcTotal(o.Total, o.Tax, o.Discount)`) in a different file. Requires reading types.go, pricing.go, and orders.go to find the mismatch.

2. **data-flow-trace**: Trace data flow across 4 files (api/handlers.go -> util/validate.go -> store/tasks.go -> store/events.go), identify a missing validation (empty actor string), add the validation in the correct layer, and add a test case.

3. **multi-pkg-refactor**: Rename `TaskStatus` to `State` and all its constants across 6 files in 4 packages. Requires understanding which files reference the type.

### Per-Task Breakdown

| Task | gpt-4.1-mini ||| gpt-5-mini ||| gpt-5.4-mini |||
|------|---|---|---|---|---|---|---|---|---|
| | Turns | Tools | Time | Turns | Tools | Time | Turns | Tools | Time |
| cross-file-bug | 4 | 5 | 9s | 8 | 7 | 16s | 3 | 5 | 3s |
| data-flow-trace | 7 | 10 | 37s | **20** | 20 | 92s | 5 | 7 | 9s |
| multi-pkg-refactor | 5 | 34 | 21s | **20** | 20 | 41s | 13 | 36 | 19s |
| **Total** | **16** | **49** | **67s** | **48** | **47** | **149s** | **21** | **48** | **31s** |

**Bold** = hit max turns (20). GPT-5 mini hit the ceiling on 2 of 3 hard tasks.

### Token Usage (Hard Tasks)

| Task | gpt-4.1-mini ||| gpt-5-mini |||| gpt-5.4-mini |||
|------|---|---|---|---|---|---|---|---|---|---|
| | Prompt | Completion | | Prompt | Completion | Reasoning | | Prompt | Completion | |
| cross-file-bug | 6,144 | 403 | | 12,211 | 754 | 320 | | 5,995 | 241 | |
| data-flow-trace | 42,477 | 1,908 | | 152,971 | 7,659 | 3,456 | | 20,467 | 1,243 | |
| multi-pkg-refactor | 15,677 | 1,452 | | 97,259 | 2,725 | 1,792 | | 134,464 | 2,081 | |
| **Total** | **64,298** | **3,763** | | **262,441** | **11,138** | **5,568** | | **160,926** | **3,565** | |

---

## Cost Analysis

### Standard Tasks (5 tasks, all pass)

| Model | Input Cost | Output Cost | **Total Cost** | **Cost/Task** | Relative |
|-------|-----------|-------------|---------------|--------------|----------|
| gpt-4.1-mini | $0.0071 | $0.0018 | **$0.0089** | **$0.0018** | 1.0x |
| gpt-5-mini | $0.0171 | $0.0095 | **$0.0266** | **$0.0053** | 3.0x |
| gpt-5.4-mini | $0.0410 | $0.0097 | **$0.0507** | **$0.0101** | 5.7x |

### Hard Tasks (3 tasks, all pass)

| Model | Input Cost | Output Cost | **Total Cost** | **Cost/Task** | Relative |
|-------|-----------|-------------|---------------|--------------|----------|
| gpt-4.1-mini | $0.0257 | $0.0060 | **$0.0317** | **$0.0106** | 1.0x |
| gpt-5-mini | $0.0656 | $0.0223 | **$0.0879** | **$0.0293** | 2.8x |
| gpt-5.4-mini | $0.1207 | $0.0160 | **$0.1367** | **$0.0456** | 4.3x |

### Combined (8 tasks)

| Model | Total Cost | Cost/Task | Wall-Clock Time | Seconds/Task |
|-------|-----------|-----------|----------------|-------------|
| gpt-4.1-mini | **$0.041** | **$0.005** | 93s | 11.6s |
| gpt-5-mini | **$0.114** | **$0.014** | 260s | 32.5s |
| gpt-5.4-mini | **$0.187** | **$0.023** | 81s | 10.1s |

---

## Key Observations

### 1. GPT-5 mini is a reasoning model — and that's a problem for agent work

GPT-5 mini uses internal reasoning tokens (like o1/o3). For a simple "say hello" prompt, it consumed 192 reasoning tokens before generating 14 tokens of output. For tool-calling tasks, reasoning tokens appeared intermittently (0-832 per turn).

**Impact**: Reasoning tokens are billed at the output rate ($2.00/1M), adding ~50% to the effective output cost. Combined with GPT-5 mini taking 2-3x more turns than other models, the total cost is 3x higher than gpt-4.1-mini despite the lower input price ($0.25 vs $0.40).

**Latency**: GPT-5 mini is the slowest model by far — 260s total vs 93s (gpt-4.1-mini) and 81s (gpt-5.4-mini). The reasoning overhead adds significant per-turn latency.

### 2. GPT-5.4 mini is the fastest but the most expensive

GPT-5.4 mini is impressively turn-efficient — it solved `cross-file-bug` in 3 turns (vs 4 for gpt-4.1-mini and 8 for gpt-5-mini) and `data-flow-trace` in 5 turns (vs 7 and 20). Total wall-clock time was the lowest at 81s.

**However**, the high per-token price ($0.75/$4.50) means it costs 4.3-5.7x more than gpt-4.1-mini per task. The turn efficiency does NOT compensate for the price differential — fewer turns still means substantial prompt token usage (context grows with each turn), and the high input price ($0.75) dominates on context-heavy work.

**On the multi-pkg-refactor hard task**, gpt-5.4-mini used 134K prompt tokens (vs 16K for gpt-4.1-mini). This is because it made many individual file read/write operations rather than batching. The 13 turns at $0.75/1M input cost $0.10 for that single task.

### 3. GPT-4.1-mini is the clear winner for cost-effective agent work

Despite being the "previous generation," gpt-4.1-mini:
- Has the lowest cost per task ($0.005 average)
- Completes in reasonable time (11.6s/task average)
- Never hit the max turns ceiling
- Uses the fewest prompt tokens (most efficient context usage)
- Has a very low input price ($0.40/1M) that dominates the cost for input-heavy work

### 4. Input cost dominates for agent workloads

Agent tasks are input-heavy: each turn re-sends the entire conversation history plus tool definitions. For context-heavy work (the stated interest), input tokens outnumber output tokens 10-20x:

| Model | Input:Output Ratio (standard) | Input:Output Ratio (hard) |
|-------|------------------------------|--------------------------|
| gpt-4.1-mini | 16:1 | 17:1 |
| gpt-5-mini | 14:1 | 24:1 |
| gpt-5.4-mini | 25:1 | 45:1 |

This means the **input price is the dominant cost factor** for agent workloads. GPT-5-mini's low input price ($0.25) is offset by its high turn count. GPT-5.4-mini's high input price ($0.75) makes it expensive despite good turn efficiency.

### 5. Turn efficiency vs cost: there's no crossover point

For GPT-5.4 mini to beat GPT-4.1 mini on cost, it would need to complete tasks in ~53% fewer turns (to compensate for the 1.875x input price). In practice, it uses 30-70% fewer turns on some tasks but 3x MORE turns on others (refactor-export). The variance is too high for the price premium to pay off.

---

## Recommendation

**For context-heavy, low-output agent work: use gpt-4.1-mini.**

It is:
- 3x cheaper than gpt-5-mini
- 5.7x cheaper than gpt-5.4-mini
- Fast enough (11.6s/task average)
- Reliable (never hit max turns)
- The best fit for input-heavy workloads where input cost dominates

**GPT-5.4 mini** is worth watching for latency-sensitive scenarios where the 20-30% wall-clock improvement matters more than the 4-5x cost increase. It could become competitive if the price drops.

**GPT-5 mini** is not recommended for agent workloads. Its reasoning model architecture adds latency, cost, and turns without improving task completion quality. All three models pass all tasks — the reasoning overhead provides no benefit for these tool-calling workflows.

**Gemini 2.5 Flash** ($0.30/$2.50) could not be tested through unified billing. If Cloudflare adds Gemini support to the unified billing path, it would be worth evaluating — the input price ($0.30) is between gpt-5-mini ($0.25) and gpt-4.1-mini ($0.40), and the output price ($2.50) is reasonable.

---

## How to Reproduce

```bash
cd packages/harness

# Standard eval
export SAM_AI_PROXY_URL="https://gateway.ai.cloudflare.com/v1/<account-id>/sam/openai/v1"
export SAM_AI_PROXY_KEY="$CF_TOKEN"
export SAM_AI_AUTH_HEADER="cf-aig-authorization"
export SAM_AI_MODEL="gpt-4.1-mini"  # or gpt-5-mini, gpt-5.4-mini
./scripts/run-eval-real.sh

# Hard eval
./scripts/run-eval-hard.sh
```
