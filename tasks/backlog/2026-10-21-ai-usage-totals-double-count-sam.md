# AI usage totals count every SAM assistant request twice

## Problem

`GET /api/usage/ai` (`apps/api/src/routes/usage.ts`) adds two sources: AI Gateway logs filtered
by `metadata.userId`, and the local provider meters from `getProviderUsage`. The private SAM
assistant (`operator/model.ts:recordOperatorStepUsage`) goes through AI Gateway with
`metadata.userId` and also records each step with `incrementProviderUsage`. Every SAM request is
therefore in both sources, and the endpoint's totals count it twice.

## Context

Found during staging verification of the /sam live-streaming PR, 2026-10-21. For the staging smoke
user, `GET /api/usage/ai?period=7d` returned `totalRequests: 232` while `byModel` showed 116 Gemma
requests: exactly double. One GLM 5.3 Flash turn added 2 gateway requests and 2 local-meter
requests (+4). The local meters were designed for direct passthrough requests that bypass AI
Gateway (see the route's doc comment). This predates the streaming PR: the operator's step
accounting already called `incrementProviderUsage` on `main`.

## Acceptance Criteria

- [ ] A request that reaches AI Gateway is counted once in `totalRequests`, `totalInputTokens`,
      `totalOutputTokens` and `totalCostUsd`.
- [ ] The SAM daily token budget (`incrementTokenUsage`) and per-user cost caps still count SAM
      usage, since they read the local counters.
- [ ] A route test seeds one gateway log and one local-meter entry for the same SAM request and
      asserts single counting. A control asserts that a direct-passthrough meter with no gateway log
      still counts.
