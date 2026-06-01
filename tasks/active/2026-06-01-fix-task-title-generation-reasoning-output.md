# Fix task title generation reasoning output

## Problem

New long-running SAM tasks are often getting fallback titles that are just the first 100 characters of the submitted prompt. Production investigation showed task-title AI Gateway calls are succeeding, but reasoning-enabled Workers AI models can return `choices[0].message.content = null` with text only in `choices[0].message.reasoning`. SAM only reads `message.content`, so it treats those successful responses as empty and falls back to prompt truncation.

## Research Findings

- `packages/shared/src/constants/ai-services.ts` sets `DEFAULT_TASK_TITLE_MODEL`; this task changes it from `@cf/google/gemma-4-26b-a4b-it` to `@cf/zai-org/glm-4.7-flash`.
- `apps/api/src/services/task-title.ts` builds title-generation requests and falls back to `truncateTitle()` when `fetchWorkersAIChatCompletion()` returns null.
- `apps/api/src/services/ai-proxy-shared.ts` sends OpenAI-compatible Workers AI chat completions through the shared Cloudflare AI Gateway and only extracts `choices[0].message.content`.
- Production AI Gateway logs for `metadata.source = task-title` showed recent calls using `@cf/google/gemma-4-26b-a4b-it` returned HTTP 200, so this is not a model availability, rate-limit, or timeout problem.
- Direct production probes showed Gemma 4 and GLM 4.7 Flash return normal `message.content` when request-level thinking is disabled with `chat_template_kwargs.enable_thinking = false` and `reasoning_effort = null`.
- Cloudflare's May 30, 2026 deprecation list includes `@cf/google/gemma-3-12b-it` and older Llama models, but not `@cf/zai-org/glm-4.7-flash` or `@cf/google/gemma-4-26b-a4b-it`.
- Public Cloudflare docs list `@cf/zai-org/glm-4.7-flash` as a current Workers AI model with 131k context, function calling, reasoning support, and low unit pricing.

## Checklist

- [x] Change task-title default model to `@cf/zai-org/glm-4.7-flash`.
- [x] Add a reusable way for utility Workers AI chat calls to pass reasoning controls.
- [x] Send thinking-disabled controls for task-title generation.
- [x] Update unit tests for the default model and outgoing gateway payload.
- [x] Update current configuration references for `TASK_TITLE_MODEL`.
- [x] Run targeted tests and repository quality checks.
- [ ] Deploy to staging through GitHub Actions and verify the changed behavior.
- [ ] Open a PR, wait for green CI, merge, and verify production deployment.

## Acceptance Criteria

- Long task title generation no longer falls back solely because a reasoning model returns text outside `message.content`.
- The default task-title utility model is current and not on Cloudflare's May 30, 2026 deprecation list.
- The title-generation request explicitly disables thinking/reasoning for models that support the controls.
- Tests prove the gateway request includes the thinking-disabled parameters.
- Staging and production verification show a new long task receives a concise generated title rather than the prompt prefix.

## References

- `apps/api/src/services/task-title.ts`
- `apps/api/src/services/ai-proxy-shared.ts`
- `packages/shared/src/constants/ai-services.ts`
- `.claude/rules/32-cf-api-debugging.md`
- `.claude/rules/33-staging-feature-validation.md`
