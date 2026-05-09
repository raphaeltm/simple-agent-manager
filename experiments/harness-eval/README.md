# Harness Eval Suite

Cost-aware model evaluation suite for SAM-native harness model selection. Compares models through SAM's Cloudflare AI Gateway on deterministic coding tasks, scoring **cost per successful task** — not just token price.

## Models Under Test

| Model | Provider | Gateway Path | Cost Source |
|-------|----------|-------------|-------------|
| Gemma 4 26B | Workers AI | `workers-ai` | Cloudflare Workers AI billing (~$0.011/1M tokens) |
| GPT-4.1 Mini | OpenAI (Unified) | `unified` | OpenAI pricing ($0.40/$1.60 per 1M tokens) |
| Claude Haiku 4.5 | Anthropic (Unified) | `unified` | Anthropic pricing ($0.80/$4.00 per 1M tokens) |

> **Note:** GPT-5 Mini is not yet available in the SAM model registry. The closest available model is `gpt-5.2` ($10/$40 per 1M tokens), which is excluded from default runs due to cost. Add it manually via `EVAL_MODELS` if needed.

## Scenarios

| ID | Category | What It Tests | Tools Used |
|----|----------|--------------|------------|
| `weather-baseline` | baseline | Two-tool loop: get_weather + calculate (F to C) | get_weather, calculate |
| `read-and-summarize` | coding | Read a file and summarize its functionality | read_file, glob |
| `grep-locate-code` | coding | Search for a function, read the file, identify callers | grep, read_file, glob |
| `missing-file-recovery` | coding | Handle a read_file error and recover via search | read_file, grep, glob |
| `propose-patch` | coding | Read code, identify a bug, propose an edit_file fix | read_file, edit_file, grep, glob |
| `interpret-test-failure` | coding | Read test output, trace to root cause, explain fix | read_file, grep, glob |
| `multi-file-refactor` | coding | Rename a function across 4 files (grep + multiple edits) | read_file, edit_file, grep, glob |
| `test-driven-fix` | coding | Given a failing test, fix the implementation | read_file, edit_file, grep, glob |
| `dependency-analysis` | coding | Read imports across 8 files and produce a dependency graph | read_file, grep, glob |

All coding scenarios use a **virtual filesystem** — deterministic, network-free, no side effects.

## Running the Suite

### Prerequisites

- Node.js 20+
- `tsx` (installed via `npx`)
- Cloudflare credentials with AI Gateway access

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CF_ACCOUNT_ID` | Yes | Cloudflare account ID |
| `CF_TOKEN` | Yes | Cloudflare API token (needs AI Gateway access) |
| `AI_GATEWAY_ID` | No | Gateway ID (default: `sam`) |
| `WORKERS_AI_COST_PER_1K_TOKENS` | No | Override Workers AI cost per 1K tokens (default: `0.000011`) |
| `EVAL_SCENARIOS` | No | Comma-separated scenario IDs to run (default: all) |
| `EVAL_MODELS` | No | Comma-separated model IDs to run (default: all) |
| `EVAL_TEMPLATES` | No | Comma-separated template IDs (default: all, template runner only) |
| `DRY_RUN` | No | Set to `true` to validate config without API calls (template runner only) |

### Run All (Standard)

```bash
CF_ACCOUNT_ID=<id> CF_TOKEN=<token> npx tsx experiments/harness-eval/run.ts
```

### Run Template Variants

```bash
# All scenarios x models x templates
CF_ACCOUNT_ID=<id> CF_TOKEN=<token> npx tsx experiments/harness-eval/run-templates.ts

# Dry run — validate config without calling APIs
DRY_RUN=true npx tsx experiments/harness-eval/run-templates.ts

# Specific templates only
EVAL_TEMPLATES=concise,structured CF_ACCOUNT_ID=... CF_TOKEN=... npx tsx experiments/harness-eval/run-templates.ts
```

### Run Specific Scenarios or Models

```bash
# Only the weather baseline
EVAL_SCENARIOS=weather-baseline CF_ACCOUNT_ID=... CF_TOKEN=... npx tsx experiments/harness-eval/run.ts

# Only Gemma
EVAL_MODELS=@cf/google/gemma-4-26b-a4b-it CF_ACCOUNT_ID=... CF_TOKEN=... npx tsx experiments/harness-eval/run.ts
```

### Analyze Results

```bash
# Analyze the most recent trace
npx tsx experiments/harness-eval/analyze.ts

# Analyze a specific trace file
npx tsx experiments/harness-eval/analyze.ts traces/template-eval-2026-05-09_12-00-00.json
```

## Credential Blockers

- **Workers AI (Gemma 4 26B):** Routes through `workers-ai/v1/chat/completions`. Auth via `Authorization: Bearer <CF_TOKEN>`. **Works** with the standard CF API token.
- **Unified API (GPT-4.1 Mini, Claude Haiku 4.5):** Routes through `compat/chat/completions`. Auth via `cf-aig-authorization: Bearer <CF_TOKEN>`. **May fail** if the CF_TOKEN lacks Unified Billing scope. The suite will record these as API errors — they do not crash the runner.

If Unified API models return 401, the eval trace will show `stopReason: "error"` with the HTTP status. This is expected and documented. To enable these models, configure a CF_TOKEN with Unified Billing access or set provider-specific API keys.

## Output: JSON Traces

Each run produces a timestamped JSON file in `experiments/harness-eval/traces/`:

```
traces/eval-2026-05-06_14-30-00.json
```

### Trace Schema (v1.0)

```typescript
{
  version: "1.0";                // Schema version
  timestamp: string;             // ISO 8601
  suite: {
    commitHash: string;          // Git short hash
    schemaVersion: string;       // For forward compat
  };
  results: [{
    scenarioId: string;
    scenarioName: string;
    category: string;            // "baseline" | "coding"
    model: {
      displayName: string;
      modelId: string;
      provider: string;
      path: "workers-ai" | "unified";
    };
    rubric: {
      pass: boolean;
      reason: string;
      checks: [{ name, pass, detail }];
    };
    usage: { prompt_tokens, completion_tokens, total_tokens };
    costUsd: number;             // Derived cost for this run
    latencyMs: number;           // Wall-clock time
    turnsUsed: number;
    stopReason: "complete" | "max_turns" | "error";
    conversation: [];            // Full messages (system, user, assistant, tool)
    toolCalls: [{                // Every tool invocation
      turn: number;
      toolName: string;
      arguments: {};
      result: string;
      isError: boolean;
    }];
    turnUsage: [];               // Per-turn token breakdown
    turnLatency: [];             // Per-turn latency in ms
    error?: string;              // Error message if stopReason is "error"
  }];
  summary: {
    totalScenarios: number;
    passedScenarios: number;
    successRate: number;         // 0-1
    totalCostUsd: number;
    costPerSuccessUsd: number;   // Key metric: total cost / passed
    avgLatencyMs: number;
    perModel: [{
      model: string;             // Display name
      provider: string;
      totalRuns: number;
      passed: number;
      successRate: number;
      totalCostUsd: number;
      costPerSuccessUsd: number;
      avgLatencyMs: number;
      totalTokens: number;
    }];
  };
}
```

## Interpreting Results

### Key Metric: Cost Per Successful Task

The primary ranking metric is `costPerSuccessUsd` — total cost divided by number of passing scenarios. This captures both:

1. **Token efficiency** — fewer tokens for the same result = lower cost
2. **Reliability** — a model that fails half the tasks pays double per success

A cheap model that fails often can be more expensive per success than a pricier model that always passes.

### Reading the Summary

```
Model: Gemma 4 26B (workers-ai)
  Pass rate:           6/6 (100%)
  Total cost:          $0.000066
  Cost/success:        $0.000011
  Avg latency:         1200ms
  Total tokens:        6000
```

- **Pass rate** — how many scenarios the model completed correctly
- **Total cost** — sum of all runs (passes + failures)
- **Cost/success** — total cost / passes. Lower is better. N/A if 0 passes.
- **Avg latency** — mean wall-clock time per scenario
- **Total tokens** — aggregate prompt + completion tokens

### Error Runs

Runs with `stopReason: "error"` indicate API-level failures (401, 500, timeout). These count toward total cost but not toward passes, increasing cost-per-success. Common causes:

- **401** — Missing or wrong credentials for the model's gateway path
- **429** — Rate limited
- **500** — Provider error

Check the `error` field in the trace JSON for the specific error message.

## Prompt Templates

Templates override the per-scenario system prompt to test how different prompting strategies affect model performance. Located in `prompts/`:

| Template | Strategy | Optimized For |
|----------|----------|---------------|
| `default` | Balanced general-purpose instructions | All models |
| `concise` | Minimal instructions, brief output | Smaller models (less prompt overhead) |
| `structured` | Explicit think-act-observe loop | Models that benefit from structured reasoning |
| `coding-focused` | Detailed tool-use examples and workflow | Models that need explicit tool guidance |

### Adding a Template

Create a markdown file in `prompts/` — the filename (without `.md`) becomes the template ID. The file content replaces the scenario's system prompt during template runs.

## Architecture

```
run.ts              — Standard entry point (scenarios x models)
run-templates.ts    — Template entry point (scenarios x models x templates)
runner.ts           — Think-act-observe loop against AI Gateway
template-runner.ts  — Template-aware runner with matrix output
templates.ts        — Prompt template loader
analyze.ts          — Results analysis and markdown report generator
models.ts           — Model registry and gateway URL/header builders
tools.ts            — Virtual filesystem + mock tool implementations
cost.ts             — Cost computation and summary aggregation
trace.ts            — JSON trace persistence and summary printing
types.ts            — TypeScript type definitions
prompts/            — Prompt template markdown files
scenarios/
  index.ts          — Scenario barrel export
  weather-baseline.ts
  read-and-summarize.ts
  grep-locate-code.ts
  missing-file-recovery.ts
  propose-patch.ts
  interpret-test-failure.ts
  multi-file-refactor.ts
  test-driven-fix.ts
  dependency-analysis.ts
traces/             — Output directory for JSON trace files (gitignored content)
```

## Adding a New Scenario

1. Create `scenarios/my-scenario.ts` following the existing pattern
2. Export it from `scenarios/index.ts`
3. Each scenario provides:
   - `systemPrompt` + `userPrompt` — the task
   - `tools` — array of `EvalTool` (definition + handler)
   - `maxTurns` — turn budget
   - `evaluate(run)` — rubric function returning pass/fail with check details
