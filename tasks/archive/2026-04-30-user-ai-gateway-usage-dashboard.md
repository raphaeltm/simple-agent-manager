# MVP: User-facing SAM AI Gateway Usage Dashboard

**Executed via /do workflow. MVP deliberately avoids D1 AI usage event storage. R2 Logpush/D1 billing ledger are beyond-MVP billing-hardening steps.**

## Problem

Users need visibility into their SAM-managed LLM usage routed through Cloudflare AI Gateway. This is the usage SAM will eventually charge for. MVP queries Gateway logs directly — no D1 `ai_usage_events` table. Direct BYOK/non-Gateway usage is out of scope.

## Research Findings

### Gateway Request Paths (metadata audit)

1. **`apps/api/src/routes/ai-proxy.ts`** (line 400-408): AI proxy sends `cf-aig-metadata` with `{ userId, workspaceId, projectId, trialId, modelId, stream, hasTools }` — 7 fields. CF supports up to 5 metadata entries; need to compact to 5 priority fields.

2. **`apps/api/src/durable-objects/sam-session/agent-loop.ts`** (line 257-261): SAM agent loop sends `{ source, userId, conversationId }` — missing `projectId`. Should add `projectId` for attribution.

3. Neither path sets `cf-aig-collect-log-payload: false` header.

### Duplicated Gateway Log Code

`admin-costs.ts` and `admin-ai-usage.ts` each independently define:
- `AIGatewayLogEntry` interface (identical)
- `AIGatewayLogsResponse` interface (identical)
- `fetchGatewayLogs()` function (identical logic)
- Period parsing (similar but different valid periods)
- Aggregation loops (similar pattern)

Must extract shared helpers to avoid a third copy.

### Existing Usage Routes

- `GET /api/usage/compute` — user's compute usage (preserve)
- `GET /api/usage/quota` — user's quota status (preserve)
- Frontend: `apps/web/src/lib/api/usage.ts` has `fetchComputeUsage()` and `fetchUserQuotaStatus()`
- Page: `apps/web/src/pages/SettingsComputeUsage.tsx` at route `/settings/usage`

### Shared Types

- `ComputeUsageResponse` and `UserQuotaStatusResponse` in `packages/shared/src/types/`

## Implementation Checklist

### Phase A: Shared Gateway Helpers

- [ ] Extract `AIGatewayLogEntry`, `AIGatewayLogsResponse`, and `fetchGatewayLogs()` into `apps/api/src/services/ai-gateway-logs.ts`
- [ ] Extract shared period-parsing utilities (`parsePeriod`, `getPeriodBounds`) into the same module
- [ ] Extract reusable aggregation helpers (aggregate-by-model, aggregate-by-day)
- [ ] Update `admin-costs.ts` and `admin-ai-usage.ts` to import from shared module
- [ ] Run typecheck to confirm refactor is clean

### Phase B: Metadata Audit & Compact Metadata

- [ ] Compact `ai-proxy.ts` metadata to 5 entries: `userId`, `projectId`, `workspaceId`, `source` (= "ai-proxy"), `sessionId` (from workspace lookup or omit)
- [ ] Add `projectId` to `agent-loop.ts` metadata (currently only has source, userId, conversationId)
- [ ] Add `cf-aig-collect-log-payload: false` header to both Gateway request paths where appropriate
- [ ] Verify existing tests still pass after metadata changes

### Phase C: User-scoped API Endpoint

- [ ] Add `GET /api/usage/ai?period=current-month|7d|30d|90d` route in `apps/api/src/routes/usage.ts`
- [ ] Require authenticated approved user (requireAuth + requireApproved)
- [ ] Use userId from auth context — never accept arbitrary userId query param
- [ ] Query Gateway logs, filter by metadata userId matching authenticated user
- [ ] Aggregate: totalCostUsd, totalRequests, totalInputTokens, totalOutputTokens, cachedRequests, errorRequests, byModel[], byDay[]
- [ ] Handle missing AI_GATEWAY_ID gracefully (empty result, not error)
- [ ] Handle CF API errors with admin-safe logs and user-safe messages
- [ ] Use configurable page size and max pages from env vars
- [ ] Add shared response type `UserAiUsageResponse` to `packages/shared/src/types/`

### Phase D: Frontend

- [ ] Add `fetchUserAiUsage(period)` to `apps/web/src/lib/api/usage.ts`
- [ ] Update `SettingsComputeUsage.tsx` → rename to `SettingsUsage.tsx` (or keep and extend)
- [ ] Add period selector (current-month, 7d, 30d, 90d)
- [ ] Add LLM usage section: KPI cards (cost, requests, input tokens, output tokens)
- [ ] Add model breakdown table/cards sorted by cost desc
- [ ] Add daily trend visualization (simple bar/sparkline or table)
- [ ] Keep existing compute usage section
- [ ] Add empty state when no Gateway usage exists
- [ ] Add note that LLM usage covers SAM-managed AI Gateway traffic only
- [ ] Mobile-first: no horizontal overflow at 375px

### Phase E: Tests

- [ ] Backend: period parsing + invalid period fallback
- [ ] Backend: user isolation — only authenticated user's metadata included
- [ ] Backend: missing Gateway ID returns empty state
- [ ] Backend: Gateway pagination capped at max pages
- [ ] Backend: malformed metadata entries ignored safely
- [ ] Backend: aggregation by model/day handles cached/error/missing cost
- [ ] Frontend: loading, error, empty, and mixed usage states
- [ ] Frontend: long model names render without overflow
- [ ] Frontend: period selector triggers data reload
- [ ] Playwright visual audit at 375px and 1280px with diverse mock data

### Phase F: Documentation

- [ ] Update CLAUDE.md recent changes section
- [ ] Document that LLM usage covers SAM-managed Gateway traffic only
- [ ] Document cost is based on CF AI Gateway log cost fields (estimate until billing formalized)
- [ ] Cite code paths for the user-facing usage endpoint

## Acceptance Criteria

- [ ] `/settings/usage` shows LLM usage from AI Gateway alongside existing compute usage
- [ ] Users see LLM usage by model for selected period
- [ ] Users see total LLM cost, requests, input/output tokens
- [ ] User isolation enforced server-side with behavioral tests
- [ ] Existing `/api/usage/compute` and `/api/usage/quota` unchanged
- [ ] Missing Gateway config produces helpful empty state
- [ ] No D1 AI usage event table added (MVP uses Gateway logs directly)
- [ ] No BYOK/non-Gateway usage tracking
- [ ] Mobile and desktop visual audits pass
- [ ] Staging deployment and verification completed

## References

- Idea: 01KQG7E9CSXT65QJ3BDDNPCB22
- `apps/api/src/routes/admin-costs.ts`
- `apps/api/src/routes/admin-ai-usage.ts`
- `apps/api/src/routes/usage.ts`
- `apps/api/src/routes/ai-proxy.ts`
- `apps/api/src/durable-objects/sam-session/agent-loop.ts`
- `apps/web/src/pages/SettingsComputeUsage.tsx`
- `apps/web/src/lib/api/usage.ts`
