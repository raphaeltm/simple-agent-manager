# LLM-Powered Task Title Generation

## Problem

When tasks are submitted from the chat interface, the title is derived by naively truncating the message to 200 characters (`task-submit.ts:133`). Long, conversational messages produce poor titles like "I need you to refactor the authentication module to use JWT tokens instead of session cookies and also update the..." — making the task list hard to scan.

## Solution

Use Cloudflare Workers AI (via Mastra + `workers-ai-provider`) to generate concise, descriptive task titles from the full message text. A small LLM summarizes the intent in ≤100 characters.

## Research Findings

- **Current title logic**: `task-submit.ts:133` — `message.length > 200 ? message.slice(0, 197) + '...' : message`
- **AI binding**: Already configured in `wrangler.toml` (`[ai] binding = "AI"`) and `Env` interface (`AI: Ai`)
- **Existing AI usage**: `transcribe.ts` uses `env.AI.run()` for Whisper — serves as canonical pattern
- **`workers-ai-provider`**: Bridges Workers AI binding to Vercel AI SDK (`createWorkersAI({ binding: env.AI })`)
- **Mastra**: Accepts Vercel AI SDK model objects directly (`model: workersai("@cf/model")`)
- **Service pattern**: `apps/api/src/services/` (see `branch-name.ts`, `encryption.ts`)
- **Constants pattern**: `packages/shared/src/constants.ts` — all limits configurable via env vars

## Implementation Checklist

- [ ] Install dependencies: `@mastra/core`, `workers-ai-provider`, `ai` (Vercel AI SDK)
- [ ] Add env var defaults to `packages/shared/src/constants.ts`
- [ ] Add env vars to `apps/api/src/index.ts` Env interface
- [ ] Create `apps/api/src/services/ai/task-title.ts` — Mastra agent for title generation
- [ ] Create `apps/api/src/services/ai/provider.ts` — shared Workers AI provider factory
- [ ] Update `apps/api/src/routes/task-submit.ts` to use LLM title generation with fallback
- [ ] Add unit tests for title generation service
- [ ] Update `apps/api/.env.example` with new env vars
- [ ] Update CLAUDE.md if needed (Active Technologies)
- [ ] Run full quality suite: lint, typecheck, test, build

## Env Vars (Constitution Principle XI — No Hardcoded Values)

| Variable | Default | Description |
|----------|---------|-------------|
| `TASK_TITLE_MODEL` | `@cf/meta/llama-3.1-8b-instruct` | Workers AI model for title generation |
| `TASK_TITLE_MAX_LENGTH` | `100` | Maximum generated title length |
| `TASK_TITLE_GENERATION_ENABLED` | `true` | Feature flag to enable/disable |
| `TASK_TITLE_TIMEOUT_MS` | `5000` | Timeout for AI call before falling back |

## Acceptance Criteria

- [ ] Tasks submitted via chat get concise, descriptive LLM-generated titles
- [ ] If AI call fails or times out, falls back to current truncation behavior
- [ ] Feature can be disabled via `TASK_TITLE_GENERATION_ENABLED=false`
- [ ] Model, max length, and timeout are configurable via env vars
- [ ] Short messages (≤100 chars) are used as-is without LLM call
- [ ] Unit tests cover success, failure/fallback, timeout, and short-message bypass

## Key Files

| File | Action |
|------|--------|
| `apps/api/package.json` | Add dependencies |
| `packages/shared/src/constants.ts` | Add defaults |
| `apps/api/src/index.ts` | Add env vars to Env interface |
| `apps/api/src/services/ai/provider.ts` | NEW — Workers AI provider factory |
| `apps/api/src/services/ai/task-title.ts` | NEW — Title generation service |
| `apps/api/src/routes/task-submit.ts` | Integrate title generation |
| `apps/api/.env.example` | Document new env vars |
| `apps/api/tests/unit/services/ai/task-title.test.ts` | NEW — Tests |

## References

- Existing AI pattern: `apps/api/src/routes/transcribe.ts`
- Branch name generation (similar service pattern): `apps/api/src/services/branch-name.ts`
- Mastra + Vercel AI SDK: Mastra accepts AI SDK model objects directly
- Workers AI provider: `createWorkersAI({ binding: env.AI })`
