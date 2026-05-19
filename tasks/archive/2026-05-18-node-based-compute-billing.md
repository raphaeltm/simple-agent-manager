# Switch compute billing and quotas to node-based tracking

## Problem

User-facing compute usage and quota enforcement currently use workspace-scoped `compute_usage` rows. That hides warm-pool and idle-between-session node runtime even though Hetzner bills from VM provision to destruction. Billing and quota surfaces need to use node lifetime as the billable entity while preserving workspace-level tracking for future per-workspace breakdowns.

## Research Findings

- `apps/api/src/services/node-usage.ts` already calculates period-clamped node-hours and vCPU-hours from `nodes.createdAt` to `nodes.updatedAt` for ended statuses, or to `now` for active nodes.
- `apps/api/src/services/compute-usage.ts` must remain intact because it records workspace sessions and supports future breakdowns plus orphan cleanup.
- `GET /api/usage/compute` in `apps/api/src/routes/usage.ts` still calls `getUserUsageSummary()` from `compute-usage.ts`.
- `checkQuotaForUser()` and admin quota usage display still call `calculateVcpuHoursForPeriod()` from `compute-usage.ts`; both need platform-node vCPU-hours.
- `apps/web/src/pages/SettingsComputeUsage.tsx` labels active workspace sessions and uses `activeWorkspaces`; it needs node-based labels and active node rows.
- `apps/web/src/pages/AdminComputeUsage.tsx` already uses `/api/admin/usage/nodes`, but legacy `/api/admin/usage/compute` still serves workspace-based data and should be redirected/consolidated to node-based responses.
- `packages/shared/src/types/compute-usage.ts` is the shared contract for user and admin compute usage responses.
- `docs/notes/2026-04-13-compute-usage-node-overlap-postmortem.md` identifies the billing-entity invariant: usage, quota, and cost changes must explicitly test the billable resource entity.

## Implementation Checklist

- [x] Add node-based vCPU-hour helper(s) to `node-usage.ts`, including a platform-only filter for quota usage.
- [x] Switch `GET /api/usage/compute` to return node-based current period data and active nodes.
- [x] Switch `checkQuotaForUser()` and admin quota current usage to node-based platform vCPU-hours.
- [x] Consolidate legacy admin compute usage routes onto node-based service data.
- [x] Update shared compute usage types while keeping backwards-compatible aliases where practical.
- [x] Update `SettingsComputeUsage.tsx` to show node-hours, node-based vCPU-hours, active node count, and active node rows.
- [x] Update Playwright audit mock data for the new user compute response shape.
- [x] Add or update tests proving idle platform node time counts for quota and user compute usage.
- [x] Run lint, typecheck, tests, build, and mandatory Playwright visual audit for changed UI.

## Acceptance Criteria

- `GET /api/usage/compute` primary totals are node-hours and node-based vCPU-hours from the `nodes` table.
- User-facing “Active Now” counts active nodes, not active workspace sessions.
- User-facing active list displays nodes, not workspace sessions.
- Quota enforcement counts only platform nodes and includes idle node time.
- BYOC/user credential nodes do not count against platform quotas.
- Workspace-level compute tracking code and tables remain in place.
- Admin compute usage endpoint and page no longer depend on workspace-based summaries for billing totals.
- Visual audit covers the changed settings compute page at mobile and desktop sizes.
