# Cost-Aware SAM Harness Model Evaluation Suite

## Problem

The existing model evaluation (`experiments/ai-gateway-tool-call/experiment.ts`) only tests a single 2-tool weather scenario (get_weather + calculate). This is insufficient for harness model selection — it validates tool-call format but not coding ability, error recovery, or cost efficiency.

We need a credible eval suite that:
- Compares models on coding-oriented tasks (not just weather)
- Scores **cost per successful task**, not just token price
- Routes through SAM's proxy to the SAM Cloudflare AI Gateway (not a separate gateway)
- Treats Workers AI/Gemma as Cloudflare-billed (not free)
- Persists rich JSON traces for observability

## Research Findings

### Existing Infrastructure
- `experiments/ai-gateway-tool-call/experiment.ts` — TypeScript, tests 5 models through AI Gateway Workers AI + Unified API paths
- `packages/harness/` — Go agent loop with tools: `read_file`, `write_file`, `edit_file`, `bash`, `grep`, `glob`
- `packages/shared/src/constants/ai-services.ts` — `PLATFORM_AI_MODELS` registry with `costPer1kInputTokens`, `costPer1kOutputTokens`, `contextWindow`, `toolCallSupport`
- AI Gateway ID: `"sam"` (from wrangler.toml)
- Auth paths: Workers AI uses `Authorization: Bearer`, Unified API uses `cf-aig-authorization: Bearer`

### Models to Test
| Model | Path | Cost (input/1k) | Cost (output/1k) |
|-------|------|-----------------|------------------|
| Gemma 4 26B | workers-ai | $0 (billed to CF) | $0 (billed to CF) |
| GPT-4.1 Mini | unified | $0.0004 | $0.0016 |
| Claude Haiku 4.5 | unified | $0.0008 | $0.004 |
| GPT-5 Mini* | unified | TBD | TBD |

*GPT-5 Mini not yet in PLATFORM_AI_MODELS — closest is gpt-5.2 ($0.01/$0.04). Will add if available or document blocker.

### Credentials Available
- `CF_TOKEN` / `CF_ACCOUNT_ID` — available in workspace
- `AI_GATEWAY_ID` — "sam" from wrangler.toml
- Unified Billing (for OpenAI/Anthropic models) — blocked in previous experiment (CF_TOKEN lacks scope). Document as blocker.

### Eval Task Design
TypeScript eval scenarios that simulate coding tasks using mock tool implementations (same approach as existing weather experiment but with harness-style tools):

1. **Weather baseline** (existing) — continuity
2. **Read file + summarize** — model reads a file, produces a summary
3. **Grep/glob locate code** — model uses grep to find a function, reads it
4. **Handle missing file error** — model tries to read a nonexistent file, recovers gracefully
5. **Propose a patch** — model reads a file, identifies a bug, proposes an edit
6. **Interpret test failure** — model receives test output, diagnoses the failure

## Implementation Checklist

- [x] Create `experiments/harness-eval/` directory structure
- [x] Create shared runner infrastructure (`runner.ts`) with:
  - Model config (gateway URL, auth header, path type)
  - Tool registry with mock implementations (get_weather, calculate, read_file, grep, glob, write_file, edit_file)
  - Multi-turn agent loop with tool dispatch
  - Token usage and latency tracking
  - Cost computation using PLATFORM_AI_MODELS registry data
- [x] Create eval scenario definitions (`scenarios/`) with:
  - weather-baseline.ts — existing 2-tool test (continuity)
  - read-and-summarize.ts — read_file + summarize
  - grep-locate-code.ts — grep + read_file chain
  - missing-file-recovery.ts — read_file error + graceful handling
  - propose-patch.ts — read_file + edit_file (bug fix)
  - interpret-test-failure.ts — read test output + diagnosis
- [x] Create trace persistence (`trace.ts`):
  - Per-run JSON file in `experiments/harness-eval/traces/`
  - Schema: model, provider, scenario, prompt/tool versions, full request/response, tool calls/results, token usage, derived cost, latency, pass/fail
- [x] Create cost model (`cost.ts`):
  - Import cost data from PLATFORM_AI_MODELS
  - Compute cost per scenario run
  - Compute cost per successful task (total cost / successful tasks)
  - Workers AI cost estimation (treat as billed, not free)
- [x] Create rubric/scoring (`rubric.ts`):
  - Per-scenario pass/fail criteria
  - Aggregate scoring (success rate, avg cost per success, avg latency)
- [x] Create main entry point (`run.ts`) that runs all scenarios against all models
- [x] Create docs (`experiments/harness-eval/README.md`):
  - How to run the suite
  - How to interpret results
  - How to add new scenarios
  - Credential requirements and blockers
- [x] Validate locally (TypeScript compiles, mock scenarios pass structure checks)

## Acceptance Criteria

- [x] Weather baseline scenario preserved for continuity
- [x] At least 5 coding-oriented scenarios defined with rubrics
- [x] JSON traces persisted per run with full request/response data
- [x] Cost per successful task computed and reported
- [x] Workers AI costs treated as Cloudflare-billed (not $0)
- [x] Docs explain how to run, interpret results, and add scenarios
- [x] Credential blockers documented (Unified Billing for OpenAI/Anthropic)
- [x] Suite runs locally against Workers AI models (Gemma 4 26B minimum)

## References

- `experiments/ai-gateway-tool-call/experiment.ts` — existing experiment
- `experiments/ai-gateway-tool-call/FINDINGS-gemma.md` — Gemma 4 evaluation
- `packages/harness/` — Go harness tools (grep, glob, read_file, etc.)
- `packages/shared/src/constants/ai-services.ts` — model registry
- Knowledge: "Prioritize SAM Gateway Proxy for Harness Experiments"
- Knowledge: "Prefer one Cloudflare AI Gateway for SAM-managed LLM traffic"
