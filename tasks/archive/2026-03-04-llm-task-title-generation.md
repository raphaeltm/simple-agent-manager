# LLM-Powered Task Title Generation

## Problem

When tasks are submitted from the chat interface, the title is derived by naively truncating the message to 200 characters (`task-submit.ts:133`). Long, conversational messages produce poor titles like "I need you to refactor the authentication module to use JWT tokens instead of session cookies and also update the..." — making the task list hard to scan.

## Solution

Use Cloudflare Workers AI (via Mastra + `workers-ai-provider`) to generate concise, descriptive task titles from the full message text. A small LLM summarizes the intent in ≤100 characters.

## Implementation Checklist

- [x] Install dependencies: `@mastra/core`, `workers-ai-provider`, `ai` (Vercel AI SDK)
- [x] Add env var defaults to `packages/shared/src/constants.ts`
- [x] Add env vars to `apps/api/src/index.ts` Env interface
- [x] Create `apps/api/src/services/task-title.ts` — Mastra agent for title generation
- [x] Update `apps/api/src/routes/task-submit.ts` to use LLM title generation with fallback
- [x] Add unit tests for title generation service (16 tests)
- [x] Update `apps/api/.env.example` with new env vars
- [x] Run full quality suite: lint, typecheck, test, build — all pass

## Acceptance Criteria

- [x] Tasks submitted via chat get concise, descriptive LLM-generated titles
- [x] If AI call fails or times out, falls back to current truncation behavior
- [x] Feature can be disabled via `TASK_TITLE_GENERATION_ENABLED=false`
- [x] Model, max length, and timeout are configurable via env vars
- [x] Short messages (≤100 chars) are used as-is without LLM call
- [x] Unit tests cover success, failure/fallback, timeout, and short-message bypass
