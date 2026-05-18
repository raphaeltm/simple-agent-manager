# Enforce AI Proxy Daily Token Budgets

## Problem

Daily AI token budgets are checked before proxy requests, but successful proxy responses are never counted. `incrementTokenUsage()` exists and is tested, yet production proxy routes do not call it, so usage remains at zero and users are never blocked by daily token limits.

## Research Findings

- `apps/api/src/services/ai-token-budget.ts` provides `checkTokenBudget()` and `incrementTokenUsage()`. The latter writes through `AI_TOKEN_BUDGET_COUNTER` when available and falls back to KV.
- `apps/api/src/routes/ai-proxy.ts` handles OpenAI-compatible chat completions for Workers AI, OpenAI, and Anthropic translation. It checks budget once, estimates input tokens for request size, then returns successful upstream responses without usage increments.
- `apps/api/src/routes/ai-proxy-anthropic.ts` handles native Anthropic messages and count_tokens. The messages route must count response usage; count_tokens should remain a pass-through because it is not an inference response.
- `apps/api/src/routes/ai-proxy-passthrough.ts` handles BYO-key Anthropic and OpenAI inference routes plus Anthropic count_tokens. The inference routes need budget increments even though credentials are user-owned.
- Streaming responses require non-blocking stream inspection. OpenAI-compatible streams may include a final `usage` chunk; Anthropic streams expose `message_start.usage.input_tokens` and `message_delta.usage.output_tokens`.
- `.claude/rules/33-staging-feature-validation.md` explicitly calls out AI budget enforcement as needing real side-effect validation, not just endpoint existence checks.

## Implementation Checklist

- [ ] Add shared token-usage extraction/accounting helpers for OpenAI JSON, Anthropic JSON, OpenAI SSE, and Anthropic SSE.
- [ ] Wire OpenAI-compatible `/ai/v1/chat/completions` responses for Workers AI, OpenAI, and translated Anthropic paths.
- [ ] Wire native Anthropic `/ai/anthropic/v1/messages` responses while leaving `/messages/count_tokens` unmetered.
- [ ] Wire passthrough Anthropic and OpenAI inference responses while leaving passthrough count_tokens unmetered.
- [ ] Add unit tests for non-streaming extraction and streaming SSE accounting fallbacks.
- [ ] Add route-level tests proving successful proxy calls increment usage and budget exhaustion returns 429 on the next request.
- [ ] Run focused tests and the required quality checks.

## Acceptance Criteria

- Successful non-streaming proxy responses increment daily usage using provider-reported input/output tokens.
- Successful streaming proxy responses increment usage from stream usage events when present.
- Streaming responses fall back to the pre-flight input token estimate when input usage is unavailable.
- Failed upstream responses and token-count-only endpoints do not increment inference usage.
- A user whose daily budget is exceeded receives a 429 on the next proxy request.

## References

- `apps/api/src/routes/ai-proxy.ts`
- `apps/api/src/routes/ai-proxy-anthropic.ts`
- `apps/api/src/routes/ai-proxy-passthrough.ts`
- `apps/api/src/services/ai-token-budget.ts`
- `apps/api/src/durable-objects/ai-token-budget-counter.ts`
- `apps/api/tests/unit/services/ai-token-budget.test.ts`
- `.claude/rules/33-staging-feature-validation.md`
