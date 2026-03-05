# Inconsistent Task Title Generation

## Problem

Task title generation via Workers AI is inconsistent. Of 4 tasks submitted in rapid succession during testing:
- 1 task got a clean AI-generated title: "Create Upgrade Plan for Project Dependencies"
- 1 task got a markdown-garbled AI-generated title (fixed by PR #264)
- 2 tasks showed the raw message text truncated as the title (no AI generation at all)

The tasks that fell back to raw message text:
- "Perform a comprehensive security audit of this repository. Check for: 1) Dependency vulnerabiliti..."
- "Add a CONTRIBUTING.md file to the repository that documents the development workflow, coding stan..."

## Context

- **Discovered**: 2026-03-05 during manual QA testing
- **Severity**: Low — functional but inconsistent UX
- **Possible cause**: Rate limiting on Workers AI, timeout during concurrent title generation (4 tasks submitted within ~60 seconds)

## Research Findings

### Root Cause Chain

1. **Task submission** (`apps/api/src/routes/task-submit.ts:135`): Calls `generateTaskTitle(c.env.AI, message, titleConfig)` synchronously in the request path
2. **AI call** (`apps/api/src/services/task-title.ts:177`): Uses `agent.generate()` with `AbortSignal.timeout(5000)` — single attempt, no retry
3. **Failure path** (`task-title.ts:196-204`): On any error (timeout, rate limit, network), catches exception and falls back to `truncateTitle(message, maxLength)`
4. **Logging**: Failures log `task_title.generation_failed` at `warn` level with error message

### Key Issue

The current implementation makes exactly one attempt. Under burst load (4+ concurrent requests), Workers AI either:
- Returns rate limit errors (HTTP 429 or equivalent)
- Responds slowly, exceeding the 5-second timeout

Both cases silently fall back to truncation. A simple retry with backoff would recover from transient failures.

### Key Files

| File | Role |
|------|------|
| `apps/api/src/services/task-title.ts` | Core title generation logic — needs retry |
| `apps/api/tests/unit/services/task-title.test.ts` | 58 existing tests |
| `apps/api/src/routes/task-submit.ts:135` | Call site (unchanged) |
| `packages/shared/src/constants.ts:201-212` | Default constants |
| `docs/guides/self-hosting.md:70` | Config documentation |

### Fix Approach

Add retry with exponential backoff to `generateTaskTitle()`:
1. Add configurable `maxRetries` (default 2) and `retryDelayMs` (default 1000)
2. Wrap the AI call in a retry loop with exponential backoff
3. Classify errors (timeout vs rate-limit vs other) in log messages
4. Add corresponding shared constants and env var support

## Implementation Checklist

- [ ] Add `DEFAULT_TASK_TITLE_MAX_RETRIES` and `DEFAULT_TASK_TITLE_RETRY_DELAY_MS` to `packages/shared/src/constants.ts`
- [ ] Add `maxRetries` and `retryDelayMs` to `TaskTitleConfig` and `TaskTitleEnvVars` in `task-title.ts`
- [ ] Update `getTaskTitleConfig()` to read new env vars
- [ ] Add retry loop with exponential backoff in `generateTaskTitle()`
- [ ] Classify errors (timeout, rate-limit, other) in warning logs
- [ ] Log retry attempts with attempt number
- [ ] Update `docs/guides/self-hosting.md` with new env vars
- [ ] Add tests for retry on first failure then success
- [ ] Add tests for retry exhaustion (all attempts fail)
- [ ] Add tests for error classification in logs
- [ ] Add test for `getTaskTitleConfig` reading new env vars

## Acceptance Criteria

- [ ] All tasks get AI-generated titles (or explicit fallback with warning log after retries exhausted)
- [ ] Title generation handles concurrent requests gracefully (retry with backoff)
- [ ] Failed title generation attempts are logged with reason (timeout, rate limit, error) and attempt number
- [ ] New config vars `TASK_TITLE_MAX_RETRIES` and `TASK_TITLE_RETRY_DELAY_MS` documented
- [ ] Test: retry succeeds on second attempt after first fails
- [ ] Test: falls back to truncation after all retries exhausted
