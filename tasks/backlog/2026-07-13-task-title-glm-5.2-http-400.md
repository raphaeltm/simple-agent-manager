# task_title generation fails in prod: Workers AI Gateway HTTP 400 on @cf/zai-org/glm-5.2

**Status:** backlog
**Discovered:** 2026-07-13, in a live prod `wrangler tail` while diagnosing VM provisioning failures.

## Problem

`generateTaskTitle` (`apps/api/src/services/task-title.ts`) fails on every attempt in
production. Prod tail:

```
task_title.retrying          error="Workers AI Gateway request failed with HTTP 400" modelId="@cf/zai-org/glm-5.2" attempt=1
task_title.retrying          ... attempt=2
task_title.generation_failed ... attempt=3
task_title.all_retries_exhausted lastError="Workers AI Gateway request failed with HTTP 400"
```

The feature degrades gracefully — it falls back to `truncateTitle()` — so task titles
still appear, just truncated rather than AI-generated. Not user-blocking, but AI titles
are effectively off in prod.

## Root cause (partial)

- `DEFAULT_TASK_TITLE_MODEL = '@cf/zai-org/glm-5.2'` (`packages/shared/src/constants/ai-services.ts:6`).
- The model **exists** in the Workers AI catalog (verified via CF API
  `GET /accounts/:id/ai/models/search?search=glm`). So the 400 is **NOT** a bad model id.
- Therefore the 400 is a **request-parameter incompatibility**. `fetchTaskTitle` sends
  `reasoningEffort: null` and `chatTemplateKwargs: { enable_thinking: false }`
  (`task-title.ts:227-228`) via `fetchWorkersAIChatCompletion`. glm-5.2 likely rejects one
  of these (or the `max_tokens`/message shape) with a 400.

## Why this was NOT fixed in the provisioning PR

Pinning down the exact rejected parameter requires **iterating against the live AI Gateway**
(send request, read 400 body, adjust param, repeat). That can't be done from the dev
environment, and staging is off-limits right now. Shipping a blind param/model change to
prod would violate `.claude/rules/30-never-ship-broken-features.md` (don't ship unverifiable
guesses). Flagged and deferred here instead.

## Acceptance criteria
- [ ] Reproduce the 400 against the AI Gateway and capture the response body to identify the rejected parameter.
- [ ] Fix `fetchTaskTitle`/`fetchWorkersAIChatCompletion` params (or switch to a verified-compatible small model) so glm-5.2 (or the chosen model) returns 200.
- [ ] Verify a real AI-generated title end-to-end.
- [ ] Consider treating HTTP 4xx (deterministic client errors) as **non-retryable** in the
      `task_title` retry loop (`classifyError`/retry in `task-title.ts`) so a deterministic 400
      doesn't burn 3 attempts + backoff before falling back to truncation.

## References
- Discovered alongside `tasks/archive/2026-07-13-hetzner-422-capacity-classification-and-retry.md`
- `packages/shared/src/constants/ai-services.ts`, `apps/api/src/services/task-title.ts`
