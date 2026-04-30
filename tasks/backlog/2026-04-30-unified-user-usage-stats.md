# Unified User Usage Stats Page

## Problem

The current `/settings/usage` page reports only current-month compute usage. Users need one user-scoped usage surface that explains compute and AI consumption for a selected period: vCPU-hours split by platform-provided compute versus BYOC, provider/source breakdowns, active resources, and AI input/output tokens by model.

User-facing AI usage must be durable and D1-backed for supported SAM-managed AI paths. It must not rely solely on live Cloudflare AI Gateway log scans, and `ai-token-budget.ts` KV counters must not be treated as the usage source unless explicitly wired and tested.

## Research Findings

- `apps/web/src/pages/SettingsComputeUsage.tsx` renders `/settings/usage` and calls `fetchComputeUsage()` plus `fetchUserQuotaStatus()` from `apps/web/src/lib/api/usage.ts`.
- `apps/api/src/routes/usage.ts` currently exposes `GET /api/usage/compute` and `GET /api/usage/quota`; these must remain compatible.
- `apps/api/src/services/compute-usage.ts` stores workspace-scoped rows in `compute_usage` but calculates billable vCPU-hours by merging overlapping intervals per `nodeId` in `calculateNodeVcpuHours`.
- `docs/notes/2026-04-13-compute-usage-node-overlap-postmortem.md` requires explicit billing-entity checks for usage/cost changes so shared node time is not double-counted.
- `apps/api/src/db/schema.ts` defines `computeUsage` adjacent to where the new `aiUsageEvents` schema should live.
- `apps/api/src/routes/ai-proxy.ts` forwards SAM-managed AI proxy requests with AI Gateway metadata and has enough user/workspace/project context to persist durable AI usage events when usage is available.
- `apps/api/src/durable-objects/sam-session/agent-loop.ts` streams SAM session AI calls through AI Gateway. Token usage capture for streams may be partial unless provider SSE usage events are reliably parsed.
- `apps/api/src/routes/admin-ai-usage.ts` and `apps/api/src/routes/admin-costs.ts` aggregate AI Gateway logs for admin views; these are useful for reconciliation but should not be the user-facing source of truth.
- `apps/api/src/services/ai-token-budget.ts` exposes `incrementTokenUsage`, but current research shows it is not the metering source for this feature.
- `apps/web/tests/playwright/compute-usage-audit.spec.ts` already mocks usage-related APIs and should be updated or split for the unified usage page visual audit.
- UI work must be mobile-first with no horizontal overflow, because the primary user frequently uses the mobile PWA.

## Implementation Checklist

- [ ] Add D1 migration and Drizzle schema for `ai_usage_events`.
- [ ] Add shared usage summary response types and export them from shared package entry points.
- [ ] Add `usage-period` service for `current-month`, `7d`, `30d`, and `90d` UTC periods with validation.
- [ ] Add `ai-usage` service for inserting durable AI usage events and aggregating user-scoped model/day/project summaries.
- [ ] Add `user-usage-summary` service that composes compute, quota, active resources, project breakdowns, and AI usage without breaking existing compute/quota endpoints.
- [ ] Add `GET /api/usage/summary?period=current-month|7d|30d|90d` with auth, approved-user checks, validation, and user isolation.
- [ ] Persist AI usage events from supported SAM-managed AI paths, starting with `apps/api/src/routes/ai-proxy.ts`; document streaming limitations if exact token capture is unavailable.
- [ ] Rebuild `/settings/usage` as a unified Usage page using existing web app patterns and Recharts where useful.
- [ ] Add frontend API client support for `fetchUserUsageSummary(period)`.
- [ ] Add API service/route behavioral tests for AI aggregation, period parsing, user isolation, and summary composition.
- [ ] Add frontend unit tests for loading, error, empty, mixed compute/AI, long model names, and mobile-safe rendering.
- [ ] Add or update Playwright visual audit with mocked diverse data for mobile 375px and desktop 1280px.
- [ ] Update user-visible docs for usage semantics, with code-path citations and explicit AI streaming limitations.
- [ ] Run targeted builds/tests during implementation and full quality gates before PR.
- [ ] Run specialist review skills appropriate to API, UI, docs, tests, and constitution compliance.
- [ ] Deploy to staging, verify D1 migration/state via Cloudflare API, verify `/settings/usage` end to end, then open a PR.

## Acceptance Criteria

- [ ] `/settings/usage` shows unified compute and AI usage with loading, error, and empty states.
- [ ] Users can see vCPU-hours split by platform versus BYOC and by cloud/provider where known.
- [ ] Users can see input/output tokens by model for their own usage only.
- [ ] Active resources are visible with started time and accumulating usage.
- [ ] API responses are user-scoped and covered by behavioral tests.
- [ ] Durable AI usage events are persisted for supported SAM-managed AI calls, with documented limitations for unsupported paths.
- [ ] Existing `/api/usage/compute` and `/api/usage/quota` remain compatible.
- [ ] No source-contract tests are added.
- [ ] No hardcoded URLs, limits, or pricing constants are added except configurable defaults that comply with Principle XI.
- [ ] Tests, typecheck, visual audit, and staging verification pass, or staging is formally blocked per policy.

## References

- Idea `01KQETG4QHXJASC70ZKADBPX0D`: Unified user usage stats page: compute, cloud source, and model token usage.
- `apps/api/src/routes/usage.ts`
- `apps/api/src/services/compute-usage.ts`
- `apps/api/src/routes/ai-proxy.ts`
- `apps/api/src/durable-objects/sam-session/agent-loop.ts`
- `apps/web/src/pages/SettingsComputeUsage.tsx`
- `apps/web/src/lib/api/usage.ts`
- `packages/shared/src/types/compute-usage.ts`
- `docs/notes/2026-04-13-compute-usage-node-overlap-postmortem.md`
