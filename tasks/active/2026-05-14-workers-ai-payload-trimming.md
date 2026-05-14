# Workers AI Model-Aware Payload Trimming

## Problem

The SAM project agent returns "AI error (413)" when using Workers AI models (e.g., Gemma 4 26B). The `trimMessagesToFit` function uses `DEFAULT_SAM_MAX_REQUEST_BODY_BYTES` (8MB), which works for Anthropic models but is ~8x too large for Workers AI models. Gemma 4 26B has a 256K token context window, exceeded at ~1MB of text.

Workers AI returns HTTP 413: `"AiError: Ai: The estimated number of input and maximum output tokens (500064) exceeded this model context window limit (256000)."`

## Root Cause

PR #1003 added the trimming infrastructure but sized the budget for Anthropic models only. The same 8MB budget is applied regardless of the model provider.

## Research Findings

- `isWorkersAIModel()` already exists in `agent-loop.ts:131` — detects `@cf/` and `@hf/` prefixes
- `resolveSamConfig()` in `packages/shared/src/constants/sam.ts` resolves `maxRequestBodyBytes` from env var `SAM_MAX_REQUEST_BODY_BYTES` or falls back to `DEFAULT_SAM_MAX_REQUEST_BODY_BYTES` (8MB)
- The trimming call site is `agent-loop.ts:636`: `trimMessagesToFit(messages, config.maxRequestBodyBytes, fixedOverhead)`
- The project agent uses `resolveSamConfig()` at `project-agent/index.ts:177` and passes config to `runAgentLoop`
- Production `SAM_MODEL` = `@cf/google/gemma-4-26b-a4b-it`
- ~800KB is a safe budget for Workers AI (256K tokens * ~3.5 bytes/token ≈ 896KB, with margin)

## Implementation Checklist

- [ ] Add `DEFAULT_SAM_MAX_REQUEST_BODY_BYTES_WORKERS_AI` constant (~819,200 = 800KB) to `packages/shared/src/constants/sam.ts`
- [ ] Export it from `packages/shared/src/constants/index.ts`
- [ ] In `agent-loop.ts`, before the `trimMessagesToFit` call, select the budget: if no env override is set AND the model is Workers AI, use the Workers AI budget; otherwise use the existing config value
- [ ] Add unit tests:
  - Verify the Workers AI constant is 819,200
  - Verify `resolveSamConfig` still uses 8MB default
  - Verify the agent loop selects the correct budget based on model type
- [ ] Update existing test for realistic multi-tool conversation to also test Workers AI budget

## Acceptance Criteria

- [ ] Workers AI models use ~800KB trimming budget instead of 8MB
- [ ] Anthropic models continue to use 8MB budget (no regression)
- [ ] Manual `SAM_MAX_REQUEST_BODY_BYTES` env var override still takes precedence for both model types
- [ ] Existing tests pass, new tests added
- [ ] Production project agent stops returning 413 errors

## References

- `packages/shared/src/constants/sam.ts` — constants and config resolver
- `apps/api/src/durable-objects/sam-session/agent-loop.ts` — trimming call site
- `apps/api/tests/unit/durable-objects/agent-loop-payload-size.test.ts` — existing tests
- `apps/api/src/durable-objects/project-agent/index.ts` — project agent entry point
