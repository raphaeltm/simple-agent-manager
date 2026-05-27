# Implement LLM Usage Metering Fixes

## Problem

SAM-managed LLM calls still have metering gaps. The top-level SAM and ProjectAgent loops route through AI Gateway but do not enforce daily AI budgets or increment token counters. Internal Workers AI utility calls for task titles and session summaries call Workers AI directly, which bypasses AI Gateway observability. Gateway metadata is also missing chat session IDs, some admin availability checks ignore the CF_API_TOKEN billing fallback, and Gateway log pagination can silently stop at the page cap.

## Research Findings

- `apps/api/src/durable-objects/sam-session/agent-loop.ts` owns `runAgentLoop()` and the private `callLLM()` path for both SamSession and ProjectAgent. It already distinguishes Anthropic vs Workers AI with `isAnthropicModel()` / `isWorkersAIModel()`, so the token accounting format can follow that decision.
- `apps/api/src/services/ai-token-budget.ts` already provides `checkAiUsageGate()` and `incrementTokenUsage()` with a Durable Object counter plus KV fallback.
- `apps/api/src/services/ai-token-usage-accounting.ts` already provides `attachTokenUsageAccounting()` and supports both streaming and JSON responses for `openai` and `anthropic` token formats.
- `apps/api/src/durable-objects/sam-session/index.ts` and `apps/api/src/durable-objects/project-agent/index.ts` call `runAgentLoop()` from a Durable Object execution context and can pass a bound `waitUntil`.
- `apps/api/src/services/task-title.ts` and `apps/api/src/services/session-summarize.ts` use Mastra + `createWorkersAI()`. These need direct Gateway fetches with `cf-aig-metadata`.
- Additional `generateTaskTitle()` call sites exist in `routes/mcp/orchestration-tools.ts`, `durable-objects/sam-session/tools/dispatch-task.ts`, and `durable-objects/sam-session/tools/retry-subtask.ts`; they also need the new `Env` signature.
- `apps/api/src/services/ai-proxy-shared.ts` has Anthropic URL helpers and Gateway metadata, but no shared Workers AI Gateway URL helper yet.
- `verifyAIProxyAuth()` resolves workspace identity from D1; metadata session identity should come from `workspaces.chatSessionId`, preserving chat-scoped routing boundaries noted in `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`.
- `docs/notes/2026-03-12-message-misrouting-and-metadata-loss-postmortem.md` reinforces that metadata loss and wrong identity boundaries need explicit tests and logging.

## Checklist

- [x] Add AI budget gate checks before every `callLLM()` loop turn and emit an SSE error when denied.
- [x] Wrap successful `callLLM()` responses with `attachTokenUsageAccounting()` using the model-derived token usage format and bound execution context.
- [x] Add `executionCtx?: Pick<ExecutionContext, 'waitUntil'>` to `runAgentLoop()` and pass it from SamSession and ProjectAgent.
- [x] Move `buildWorkersAIGatewayUrl()` into `ai-proxy-shared.ts` and import it where needed.
- [x] Replace task-title Mastra/Workers AI binding calls with direct Workers AI Gateway fetches and metadata.
- [x] Replace session-summary Mastra/Workers AI binding calls with direct Workers AI Gateway fetches and metadata.
- [x] Update all `generateTaskTitle()` and `summarizeSession()` call sites to pass `Env`.
- [x] Add `chatSessionId` to AI proxy auth results and propagate `sessionId` into AI Gateway metadata for OpenAI, Anthropic, and passthrough routes.
- [x] Log a warning when Gateway log pagination reaches `maxPages` while more pages exist.
- [x] Use `resolveUnifiedBillingToken()` for admin model availability checks in GET and PUT handlers.
- [x] Update/add tests for Gateway routing, metadata, pagination warning, budget accounting, and billing-token fallback behavior.
- [x] Run focused tests and the required quality checks.

## Acceptance Criteria

- Agent-loop LLM calls deny requests before the upstream call when the user is over budget.
- Agent-loop streaming responses increment token usage using the correct provider format without blocking stream delivery.
- Task-title and session-summary Workers AI calls go through the configured AI Gateway and include source metadata.
- AI Gateway metadata includes `sessionId` whenever a workspace has a chat session ID.
- Gateway log truncation at `maxPages` is observable through `log.warn()`.
- Admin model availability treats `CF_API_TOKEN` fallback as a unified billing token through `resolveUnifiedBillingToken()`.
- Tests cover the changed behavior with realistic boundary mocks.

## References

- Idea: `01KSNPGDWB1DQ9R1JMGJ9BVNHX`
- `apps/api/src/durable-objects/sam-session/agent-loop.ts`
- `apps/api/src/services/ai-token-budget.ts`
- `apps/api/src/services/ai-token-usage-accounting.ts`
- `apps/api/src/services/task-title.ts`
- `apps/api/src/services/session-summarize.ts`
- `apps/api/src/services/ai-proxy-shared.ts`
- `apps/api/src/services/ai-billing.ts`
- `apps/api/src/routes/admin-ai-proxy.ts`
- `apps/api/src/services/ai-gateway-logs.ts`
- `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`
- `docs/notes/2026-03-12-message-misrouting-and-metadata-loss-postmortem.md`
