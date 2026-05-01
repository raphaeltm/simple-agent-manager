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
