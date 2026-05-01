# Monthly Cost Cap Enforcement in AI Proxy

## Problem

The monthly cost cap (`monthlyCostCapUsd`) is stored and displayed with utilization percentage in the budget settings UI, but it is NOT enforced in the AI proxy request path. Daily token limits are enforced via `checkTokenBudget()` in the proxy middleware, but monthly cost requires iterating AI Gateway logs — too expensive per-request.

## Context

- Discovered during WP5 task-completion-validator review
- Daily token limits ARE enforced (via KV read in `checkTokenBudget`)
- Monthly cost aggregation requires `iterateGatewayLogs()` which paginates through CF API
- This is a performance/architecture constraint, not a missing implementation

## Proposed Approach

1. Add a cron job (e.g., hourly) that aggregates monthly cost per user and writes to KV
2. The AI proxy checks the KV-cached monthly cost on each request
3. If cached cost >= cap, reject with 429

## Acceptance Criteria

- [ ] Monthly cost cap is enforced in the AI proxy (requests rejected when cap exceeded)
- [ ] Cost is aggregated periodically (cron), not per-request
- [ ] KV cache key has appropriate TTL (1 hour)
- [ ] Test verifies enforcement
