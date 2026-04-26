# SAM Phase A Hardening — Rate Limiting + Tests + Playwright Audit

## Problem Statement

PR #823 shipped SAM Phase A (agent loop, DO, chat routes) but the task completion validator identified gaps:

1. **CRITICAL**: Rate limiting constants exist but `runAgentLoop` / `handleChat` never enforce them
2. **HIGH**: No message persistence test — SamSession DO never instantiated in tests
3. **HIGH**: No agent loop streaming test — `runAgentLoop` never tested with mocked Anthropic
4. **HIGH**: No Playwright visual audit for mobile overflow on `/sam` page
5. **MEDIUM**: No integration test for SAM chat route

## Research Findings

- Rate limit config: `rateLimitRpm` and `rateLimitWindowSeconds` resolved in `resolveSamConfig()` but never read by `handleChat()` or `runAgentLoop()`
- SamSession DO uses `ctx.storage.sql` and `ctx.storage.transactionSync()` — needs Miniflare workers pool for real DO instantiation
- Agent loop calls `callAnthropic()` → `processAnthropicStream()` — test needs to mock `fetch` and return a streaming Anthropic SSE response
- Existing workers tests in `apps/api/tests/workers/` use `vitest.workers.config.ts` with `@cloudflare/vitest-pool-workers`
- SamSession DO binding NOT in `vitest.workers.config.ts` yet — needs adding
- Playwright audit pattern well-established: mock API routes, capture screenshots, assert no overflow
- `/sam` page is at `apps/web/src/pages/SamPrototype.tsx` — ~760 lines, uses WebGL background + glass styles

## Implementation Checklist

- [ ] 1. Add rate limiting to `SamSession.handleChat()` using DO SQLite for atomic tracking
- [ ] 2. Add `SAM_SESSION` binding to `vitest.workers.config.ts`
- [ ] 3. Write workers integration test: SamSession DO message persistence (create conversation, persist messages, load history, verify sequence ordering)
- [ ] 4. Write unit test: `runAgentLoop` with mocked `fetch` returning Anthropic SSE stream (verify text_delta, tool_start, tool_result, done events emitted)
- [ ] 5. Write unit test: `processAnthropicStream` with synthetic Anthropic events
- [ ] 6. Write workers integration test: SAM chat route (POST /chat, GET /conversations, GET /conversations/:id/messages)
- [ ] 7. Write Playwright visual audit: `/sam` page with mocked SSE responses, mobile + desktop, overflow assertions
- [ ] 8. Upload Playwright screenshots to appropriate directory

## Acceptance Criteria

- [ ] Rate limiting enforced: messages per minute tracked per user in DO SQLite, 429 returned when exceeded
- [ ] SamSession DO instantiated in workers test pool with real SQLite
- [ ] Agent loop test verifies SSE events emitted in correct order
- [ ] Playwright screenshots captured at mobile (375x667) and desktop (1280x800) with no horizontal overflow
- [ ] All existing tests pass, no regressions
