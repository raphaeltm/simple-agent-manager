# Harden AI Monthly Cost Cron TTL Parsing

## Problem Statement

The hourly AI monthly-cost aggregation cron writes per-user current-month costs into KV for `checkMonthlyCostCap()` to read at request time. It currently resolves `AI_MONTHLY_COST_CACHE_TTL_SECONDS` with `parseInt(env...) || DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS`.

Negative values are truthy, so a value like `-1` is passed directly to `env.KV.put(..., { expirationTtl: -1 })`. Cloudflare KV rejects invalid TTL values, making every monthly-cost cache write fail. Because the request-time monthly cap check intentionally fails open when the cache is missing, a bad TTL silently disables monthly-cost cap enforcement while only cron logs show errors.

This is a billing/control-plane safety path. Configuration-fed TTLs must be bounded, deterministic, and covered by focused regression tests.

## Research Findings

- `apps/api/src/services/ai-monthly-cost-cron.ts`
  - `runMonthlyCostAggregation()` exits disabled when `AI_GATEWAY_ID` is absent.
  - It computes `monthKey` from the current UTC date and iterates current-month AI Gateway logs with a scheduled-cron pagination default of 200 pages and hard cap of 500 pages.
  - It aggregates `entry.cost || 0` by `entry.metadata?.userId` and writes `ai-monthly-cost:{userId}:{YYYY-MM}` values to KV with the configured TTL.
  - Current TTL parsing accepts negative values and is untested.
- `apps/api/src/services/ai-gateway-logs.ts`
  - `resolveGatewayPagination()` already uses bounded deterministic parsing: invalid/below-min values fall back, fractional values floor, and high values clamp to a hard cap.
  - This is the local pattern to mirror for the TTL resolver.
- `apps/api/src/services/ai-token-budget.ts`
  - `checkMonthlyCostCap()` reads the KV cache and intentionally fails open when there is no cached monthly cost.
  - Existing tests verify the fail-open read behavior but not the cron writer that populates the cache.
- `packages/shared/src/constants/ai-services.ts`
  - Defines `AI_MONTHLY_COST_CACHE_KV_PREFIX` and `DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS = 7200`.
- `apps/api/src/env.ts`
  - Declares `AI_MONTHLY_COST_CACHE_TTL_SECONDS` with a default-only comment. If a max cap is externally meaningful, update this comment with the accepted range/cap.
- Adjacent tests:
  - `apps/api/tests/unit/ai-gateway-logs.test.ts` covers pagination parsing and iteration.
  - `apps/api/tests/unit/services/ai-token-budget.test.ts` covers monthly cap reads.
  - `apps/api/tests/unit/usage-budget-routes.test.ts` mocks `iterateGatewayLogs` at the service boundary.
- Relevant rules:
  - `.claude/rules/02-quality-gates.md` requires regression tests and a post-mortem/process fix for bug fixes.
  - `.claude/rules/03-constitution.md` requires configurable values with defaults and no unbounded hardcoded limits.
  - `.claude/rules/35-vertical-slice-testing.md` calls out cron/background processes that read one system and write another as cross-boundary flows requiring realistic boundary mocks.

## Post-Mortem

### What Broke

Monthly-cost cap cache writes could all fail if `AI_MONTHLY_COST_CACHE_TTL_SECONDS` was configured to an invalid negative value. The request-time cap check then failed open because no cache entries existed.

### Root Cause

The cron writer introduced in `29396507` used `parseInt(raw, 10) || DEFAULT` for the KV TTL. A later hardening commit, `e3b9b78a`, added pagination bounds and monthly cap read tests but did not add direct cron writer tests or validate the TTL configuration path.

### Timeline

- `29396507` added monthly AI cost caps via cron + KV cache + proxy gate.
- `e3b9b78a` hardened monthly AI cost cap enforcement but left TTL parsing unbounded.
- The June 26 CTO spot check identified that invalid TTL configuration can disable monthly cap enforcement.

### Why It Wasn't Caught

Testing focused on the Gateway pagination helper and the request-time monthly cap reader. There was no direct unit test for the scheduled monthly-cost writer, so invalid env values reaching KV `expirationTtl` were not exercised.

### Class Of Bug

Configuration-fed safety control accepts invalid boundary values and fails open through a downstream cache miss.

### Process Fix

Update the relevant agent rule or checklist so billing/control-plane safety writers that populate enforcement caches must have tests for invalid configuration values at the write boundary, not only tests for request-time readers.

## Implementation Checklist

- [ ] Add a typed TTL resolver near the monthly-cost cron that uses `DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS`, rejects invalid/empty/zero/negative/NaN/below-min values by falling back to the shared default, floors positive fractional values, and caps excessively large values to a documented maximum.
- [ ] Use the resolver in `runMonthlyCostAggregation()` so KV writes never receive invalid `expirationTtl` from configuration.
- [ ] Update `apps/api/src/env.ts` comment if the TTL cap/range becomes externally meaningful.
- [ ] Add focused unit tests for `runMonthlyCostAggregation()`:
  - [ ] disabled when `AI_GATEWAY_ID` is absent.
  - [ ] aggregates per-user costs and writes expected `ai-monthly-cost:{userId}:{YYYY-MM}` keys with safe TTL.
  - [ ] invalid/negative TTL falls back to `DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS`.
  - [ ] excessively high TTL is capped.
  - [ ] Gateway iteration failure returns `errors: 1` without KV writes.
  - [ ] per-user KV write failures increment `errors` without stopping other users.
- [ ] Mock `iterateGatewayLogs` at the service boundary and control dates for deterministic month keys.
- [ ] Add direct TTL resolver tests if the resolver is exported.
- [ ] Add the bug-class process fix required by `.claude/rules/02-quality-gates.md`.
- [ ] Run targeted API unit tests:
  - [ ] `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/ai-monthly-cost-cron.test.ts tests/unit/ai-gateway-logs.test.ts tests/unit/services/ai-token-budget.test.ts tests/unit/usage-budget-routes.test.ts`
- [ ] Run API lint and typecheck for touched code.
- [ ] Run broader affected tests if targeted validation exposes a shared issue.
- [ ] Run relevant local specialist reviews before PR: `task-completion-validator`, `cloudflare-specialist`, `env-validator`, `constitution-validator`, and `test-engineer`.
- [ ] Open a PR describing this as fail-open budget-control hardening, wait for CI, merge when green, and monitor production deploy.

## Acceptance Criteria

- Invalid, empty, zero, negative, NaN, and below-min TTL env values cannot reach KV `expirationTtl`.
- Positive fractional TTLs floor deterministically.
- Excessively high TTL values are capped to a documented maximum.
- The monthly-cost cron writer has focused tests for disabled, success, invalid TTL, capped TTL, Gateway failure, and partial KV write failure behavior.
- Existing adjacent AI Gateway, token budget, and usage budget route tests still pass.
- API lint and typecheck pass.
- The PR includes post-mortem/process-fix evidence and specialist review evidence.

## References

- `apps/api/src/services/ai-monthly-cost-cron.ts`
- `apps/api/src/services/ai-gateway-logs.ts`
- `apps/api/src/services/ai-token-budget.ts`
- `apps/api/src/index.ts`
- `apps/api/src/env.ts`
- `packages/shared/src/constants/ai-services.ts`
- `apps/api/tests/unit/ai-gateway-logs.test.ts`
- `apps/api/tests/unit/services/ai-token-budget.test.ts`
- `apps/api/tests/unit/usage-budget-routes.test.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/03-constitution.md`
- `.claude/rules/35-vertical-slice-testing.md`
