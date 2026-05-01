# WP5: User-Facing Usage & Budget Controls

## Problem Statement

Users have no way to set personal AI usage budgets or see how close they are to exceeding limits. The existing daily token budget (`ai-token-budget.ts`) is admin-configured via env vars — users can't customize their own limits. This WP adds user-configurable budget controls and integrates budget utilization display into the existing usage dashboard.

## Research Findings

### What Already Exists
- **Usage API**: `GET /api/usage/ai` queries AI Gateway logs by userId, aggregates by model/day/cost (`apps/api/src/routes/usage.ts`)
- **Usage UI**: `AiUsageSection` in `SettingsComputeUsage.tsx` — KPI cards, per-model breakdown, daily trend bars
- **Admin token budget**: `ai-token-budget.ts` — per-user daily input/output token tracking via KV with `ai-budget:{userId}:{date}` key pattern
- **Model catalog**: `PLATFORM_AI_MODELS` in `packages/shared/src/constants/ai-services.ts` with cost fields and tier classification
- **Frontend API**: `fetchUserAiUsage()` in `apps/web/src/lib/api/usage.ts`
- **Shared types**: `UserAiUsageResponse` in `packages/shared/src/types/ai-usage.ts`

### Architecture Decisions
- Store user budget settings in KV (keyed by `ai-budget-settings:{userId}`) — lightweight, no schema migration needed
- User budgets override platform defaults when set (user → platform → unlimited)
- Budget check in proxy uses existing `checkTokenBudget()` but enhanced to consider user-set limits
- Query AI Gateway logs directly — no duplicate metering table (per Raphaël's preference)

### Key Files
- `apps/api/src/routes/usage.ts` — extend with budget CRUD endpoints
- `apps/api/src/services/ai-token-budget.ts` — enhance to support user-configurable limits
- `packages/shared/src/types/ai-usage.ts` — add budget types
- `packages/shared/src/constants/ai-services.ts` — add budget defaults
- `apps/web/src/pages/SettingsComputeUsage.tsx` — add budget settings form and utilization display
- `apps/web/src/lib/api/usage.ts` — add budget API functions
- `apps/api/src/routes/ai-proxy.ts` — wire user budgets into proxy flow

## Implementation Checklist

### 1. Shared types and constants
- [ ] Add `UserAiBudgetSettings` type to `packages/shared/src/types/ai-usage.ts`
- [ ] Add `UserAiBudgetResponse` type (combines settings + current usage)
- [ ] Add budget default constants to `packages/shared/src/constants/ai-services.ts`
- [ ] Export new types from shared index

### 2. Budget settings API (`apps/api/src/routes/usage.ts`)
- [ ] `GET /api/usage/ai/budget` — returns current budget settings + current usage against limits
- [ ] `PUT /api/usage/ai/budget` — update budget settings (validated with reasonable bounds)
- [ ] KV storage: `ai-budget-settings:{userId}` key
- [ ] Budget response includes: settings, current daily token usage, current month cost, utilization percentages

### 3. Budget enforcement in AI proxy
- [ ] Enhance `checkTokenBudget()` to load user-configurable limits from KV (fallback to platform defaults)
- [ ] Add monthly cost cap check using estimated cost from model catalog
- [ ] Return 429 with `BUDGET_EXCEEDED` error type when over budget
- [ ] Cache budget settings in KV with configurable TTL to avoid reading on every request

### 4. Budget UI in Settings
- [ ] Add `BudgetSettingsSection` component to `SettingsComputeUsage.tsx`
- [ ] Budget utilization progress bars (daily tokens, monthly cost)
- [ ] Form fields: daily token limit (input/output), monthly cost cap, alert threshold
- [ ] Clear messaging about what happens when budget is exceeded
- [ ] Mobile-first layout (grid on desktop, stacked on mobile)

### 5. Frontend API functions
- [ ] `fetchUserAiBudget()` — GET budget settings + usage
- [ ] `updateUserAiBudget()` — PUT budget settings

### 6. Tests
- [ ] API test: budget CRUD (get default, update, read back)
- [ ] API test: budget enforcement — proxy returns 429 when over daily token budget
- [ ] API test: budget enforcement — proxy returns 429 when over monthly cost cap
- [ ] API test: budget enforcement — proxy allows requests when under budget
- [ ] API test: user budgets override platform defaults
- [ ] UI test: budget settings form renders and submits
- [ ] UI test: utilization progress bars display correctly

### 7. Documentation sync
- [ ] Update CLAUDE.md Recent Changes section
- [ ] Update env var reference if new env vars added

## Acceptance Criteria

1. Users can view their current AI usage statistics (already working — verify not regressed)
2. Users can set personal daily token limits and monthly cost caps via Settings > Usage
3. Budget settings persist across sessions (stored in KV)
4. AI proxy enforces user-set budget limits, returning 429 when exceeded
5. Budget utilization is displayed with progress bars showing current vs. limit
6. All limits are configurable via environment variables (Constitution Principle XI)
7. Mobile-friendly layout with no horizontal overflow
8. Tests cover CRUD, enforcement, and UI rendering

## References

- Task description in SAM: 01KQGH6Y1HHBJJJZGWHW7WV7WG
- Output branch: sam/wp5-user-facing-usage-01kqgh
- Related PRs: WP1 (#859), WP2 (#862), WP3 (#865), WP4 (#864), WP6 (#861)
