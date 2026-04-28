# Cost Monitoring Admin Dashboard

## Problem Statement

The admin dashboard has no dedicated cost visibility. AI usage data exists in the Analytics tab (via AI Gateway logs), but lacks a cost-focused view with monthly aggregation, per-user breakdown, monthly projections, and combined LLM + compute cost visibility. Raphaël needs actionable cost visibility ("Total LLM Spend this month: $X") to understand operational expenses.

## Research Findings

### Existing Infrastructure
1. **AI Gateway Logs API** — Cloudflare AI Gateway already calculates per-request costs in USD. The `admin-ai-usage.ts` route (`/api/admin/analytics/ai-usage`) fetches and aggregates these by model and day. The `cost` field in each log entry is authoritative.
2. **AI Gateway Metadata** — Each request includes `cf-aig-metadata` with `userId`, `projectId`, `trialId`, `workspaceId`, `modelId`. This enables per-user and per-project cost attribution.
3. **AIUsageChart.tsx** — Already shows an "Est. Cost" KPI card and per-model cost in the model breakdown table. But it's buried in the Analytics tab and lacks monthly focus, per-user attribution, and projection.
4. **Compute Usage** — `AdminComputeUsage.tsx` shows node-hours by user. VM pricing can be estimated from `VM_SIZE_SPECS` in shared constants.
5. **Admin tab system** — `Admin.tsx` defines tabs rendered via `@simple-agent-manager/ui` `Tabs` component, routing via React Router `Outlet`.

### What Needs to Be Built
- A new **"Costs" admin tab** at `/admin/costs` providing a cost-first view
- **Enhanced backend** endpoint (`/api/admin/costs`) that aggregates:
  - LLM costs from AI Gateway with per-user and per-project breakdown
  - Monthly projection based on daily spend rate
  - Compute cost estimation from node-hours
- **Frontend component** (`AdminCosts.tsx`) with:
  - Monthly cost summary card (LLM + Compute)
  - Monthly projection based on current daily rate
  - Daily cost trend area chart
  - LLM cost by model table
  - LLM cost by user table
  - Compute cost by user summary

### Key Files
- `apps/api/src/routes/admin-ai-usage.ts` — existing AI usage aggregation
- `apps/api/src/routes/admin-analytics.ts` — analytics query patterns
- `apps/web/src/pages/admin-analytics/AIUsageChart.tsx` — existing cost display
- `apps/web/src/pages/Admin.tsx` — admin tab definitions
- `apps/web/src/App.tsx` — admin route definitions
- `apps/web/src/hooks/useAdminAnalytics.ts` — data fetching pattern
- `apps/web/src/lib/api/admin.ts` — admin API client functions
- `packages/shared/src/types/admin.ts` — admin-related types
- `packages/shared/src/constants/ai-services.ts` — model definitions

## Implementation Checklist

### Backend
- [ ] Create `apps/api/src/routes/admin-costs.ts` with `GET /api/admin/costs` endpoint
  - Reuse AI Gateway log fetching from `admin-ai-usage.ts`
  - Add per-user aggregation using `metadata.userId`
  - Add per-project aggregation using `metadata.projectId`
  - Calculate monthly projection: `(totalCostSoFar / daysElapsed) * daysInMonth`
  - Fetch compute cost data from D1 node-hours
  - Configurable via `COST_MONITORING_ENABLED` env var (default: true)
- [ ] Register the route in `apps/api/src/index.ts`
- [ ] Add shared types for the cost response in `packages/shared/src/types/admin.ts`

### Frontend
- [ ] Create `apps/web/src/pages/AdminCosts.tsx` — main cost monitoring page
  - Monthly cost summary cards (LLM total, Compute estimate, Combined, Projection)
  - Daily cost trend area chart (cost in USD over time)
  - Cost by model table (sorted by cost desc)
  - Cost by user table (top spenders)
  - Period selector (current month, last 30d, last 90d)
- [ ] Add "Costs" tab to `Admin.tsx` ADMIN_TABS array
- [ ] Add route in `App.tsx` for `/admin/costs`
- [ ] Add API client function in `apps/web/src/lib/api/admin.ts`

### Tests
- [ ] Unit tests for cost aggregation logic (projection calculation, per-user grouping)
- [ ] Integration test for the `/api/admin/costs` endpoint (Miniflare)
- [ ] Verify the endpoint requires superadmin auth

### Documentation
- [ ] Update CLAUDE.md Recent Changes section

## Acceptance Criteria

- [ ] New "Costs" tab visible in admin dashboard for superadmin users
- [ ] Monthly LLM cost displayed with total and per-model breakdown
- [ ] Per-user LLM cost attribution shown (from AI Gateway metadata)
- [ ] Monthly cost projection calculated from daily spend rate
- [ ] Compute cost estimation shown alongside LLM costs
- [ ] Daily cost trend chart displays cost over time
- [ ] Period selector works (current month / 30d / 90d)
- [ ] Page shows helpful empty state when no AI Gateway is configured
- [ ] All values configurable via env vars (no hardcoded values)
- [ ] Superadmin auth required
- [ ] Mobile-responsive layout (Raphaël uses mobile PWA)
