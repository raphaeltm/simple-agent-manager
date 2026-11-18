# Integration Test for OpenAI AI Gateway Routing

## Problem

PR #861 (WP6 Model Catalog Expansion) added OpenAI model routing through `forwardToOpenAI()`, but no test exercises the full routing dispatch path. Unit tests cover `isOpenAIModel()`, `getModelProvider()`, and `normalizeModelId()`, but the actual route handler branch (`if (provider === 'openai')` -> `forwardToOpenAI()` -> URL construction) is untested.

Discovered by the task-completion-validator after PR merge.

## Acceptance Criteria

- [ ] Test mocks `fetch` and calls the ai-proxy route handler with `model: "gpt-4.1"`
- [ ] Asserts the outbound fetch URL contains `/openai/v1/chat/completions`
- [ ] Asserts correct AI Gateway URL structure (account ID, gateway ID, provider path)
- [ ] Tests both streaming and non-streaming OpenAI requests
- [ ] Verifies OpenAI credential resolution path (CF_AIG_TOKEN or platform credential)

## Reconciliation (2026-11-09 weekly queue sweep)

- Evidence: apps/api/tests/unit/routes/ai-proxy-accounting.test.ts:351 covers OpenAI Responses forwarding; no test drives forwardToOpenAI chat-completions branch (ai-proxy-upstream.ts:203) asserting the gateway /openai/v1/chat/completions URL
- Status: Remaining: route-level OpenAI chat-completions URL test, streaming and non-streaming
