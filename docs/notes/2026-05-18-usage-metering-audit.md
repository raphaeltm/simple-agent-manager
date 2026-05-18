# Usage Metering, Cost Caps, and Admin Override Audit

Date: 2026-05-18

Scope: read-only trace of SAM's AI token/cost metering, compute vCPU-hour quotas, admin per-user override surfaces, AI Gateway log aggregation, and user-facing usage visibility.

## Summary Table

| Feature | Status | Severity | Recommended fix |
| --- | --- | --- | --- |
| Monthly AI cost cap (`monthlyCostCapUsd`) | Display-only | Critical | Add periodic per-user monthly cost aggregation into KV/D1 and make every AI proxy path reject when cached cost is at or above the configured cap. |
| Daily AI token budget gate | Intended enforcement, but accounting write path appears missing | Critical | Wire token accounting after successful proxy responses, or replace daily token counters with Gateway-derived cached aggregates; add route-level tests that counters increase. |
| `AiTokenBudgetCounter` monthly aggregation | Missing | High | Extend storage with monthly cost/token aggregates or add a separate monthly budget aggregate store keyed by user and month. |
| User-managed AI budget settings | Exists | Medium | Keep user self-service settings, but make UI copy accurately distinguish enforced daily limits from display-only monthly cost until enforcement lands. |
| Admin per-user AI token budget override | Missing | High | Add superadmin APIs/UI to set user AI budget overrides, or explicitly decide that users self-manage within platform maximums only. |
| Admin per-user AI monthly cost cap override | Missing | High | Add admin-managed AI budget/cap store and decide precedence over user self-service settings. |
| Compute vCPU-hour default quota | Enforced for platform-provisioned compute | High | Keep current gate, but add race-resistant reservation/active-projection checks before provisioning. |
| Compute per-user quota override | Enforced for platform-provisioned compute | Medium | Improve admin user picker/listing so admins can set overrides for users with no current usage/override. |
| Compute quota overrun after workspace starts | Soft overrun possible | Medium | Check projected active usage, reserve quota before provisioning, and optionally stop/deny renewals when active sessions cross cap. |
| BYOC compute exemption | Enforced by credential source | Low | Keep provider-specific credential-source check; clarify in UI that generic BYOC display is informational. |
| AI Gateway cost aggregation | On-demand, capped pagination | High | Add incremental aggregation/cache; expose truncation/completeness metadata in API responses. |
| User-facing usage visibility | Partial | Medium | Show aggregation limits/freshness, explain tracked vs untracked traffic, and fix budget-exceeded copy for monthly cap. |

## 1. Monthly Cost Cap Enforcement

### What exists

- `monthlyCostCapUsd` is part of `UserAiBudgetSettings` in `packages/shared/src/types/ai-usage.ts:39`.
- User budget settings are stored in KV under `ai-budget-settings:{userId}`. `buildBudgetSettingsKey()` builds that key in `apps/api/src/services/ai-token-budget.ts:80`, and `getUserBudgetSettings()`, `saveUserBudgetSettings()`, and `deleteUserBudgetSettings()` read/write/delete it at `apps/api/src/services/ai-token-budget.ts:85`, `apps/api/src/services/ai-token-budget.ts:94`, and `apps/api/src/services/ai-token-budget.ts:104`.
- `validateBudgetUpdate()` accepts and validates `monthlyCostCapUsd` against env-configurable min/max bounds at `apps/api/src/services/ai-token-budget.ts:123` and `apps/api/src/services/ai-token-budget.ts:153`.
- `GET /api/usage/ai/budget` reads the saved settings, iterates AI Gateway logs for the current month, sums matching `metadata.userId` cost, computes `monthlyCostPercent`, and returns an `exceeded` flag at `apps/api/src/routes/usage.ts:181`, `apps/api/src/routes/usage.ts:191`, `apps/api/src/routes/usage.ts:197`, `apps/api/src/routes/usage.ts:222`, and `apps/api/src/routes/usage.ts:226`.
- `PUT /api/usage/ai/budget` validates and saves the settings to KV at `apps/api/src/routes/usage.ts:252` and `apps/api/src/routes/usage.ts:269`.
- The Settings > Usage UI renders monthly cap utilization when set at `apps/web/src/pages/SettingsComputeUsage.tsx:366` and lets the user edit the cap at `apps/web/src/pages/SettingsComputeUsage.tsx:291`.
- The backlog task `tasks/backlog/2026-05-01-monthly-cost-cap-enforcement.md` explicitly says the monthly cap is stored/displayed but not enforced in the AI proxy path, and proposes hourly aggregation to KV plus proxy-time checks (`tasks/backlog/2026-05-01-monthly-cost-cap-enforcement.md:5`, `tasks/backlog/2026-05-01-monthly-cost-cap-enforcement.md:16`).

### What is missing

- No AI proxy request path checks `monthlyCostCapUsd`. `apps/api/src/routes/ai-proxy.ts` checks only `checkTokenBudget()` at `apps/api/src/routes/ai-proxy.ts:439`. The native Anthropic and passthrough routes do the same daily-token check, based on the grep trace of `checkTokenBudget()` call sites.
- `checkTokenBudget()` does not read monthly cost or `monthlyCostCapUsd`; it loads user settings only to resolve daily input/output token limits, reads daily token usage, and returns `allowed` based on daily token counts (`apps/api/src/services/ai-token-budget.ts:194`, `apps/api/src/services/ai-token-budget.ts:200`, `apps/api/src/services/ai-token-budget.ts:204`).
- `AiTokenBudgetCounter` has only a `budget_date` primary key and `input_tokens`/`output_tokens` columns. There is no month key, cost column, or aggregation query (`apps/api/src/durable-objects/ai-token-budget-counter.ts:14`).
- There is no cron/incremental monthly cost aggregator. AI Gateway cost is always recomputed by iterating logs on demand in `/api/usage/ai`, `/api/usage/ai/budget`, `/api/admin/costs`, and `/api/admin/analytics/ai-usage`.
- Important adjacent issue: `incrementTokenUsage()` exists in `apps/api/src/services/ai-token-budget.ts:213`, but a repository-wide call-site search found no production callers. If that remains true, the daily token counter read by `checkTokenBudget()` will not increase from normal proxy traffic, making daily token enforcement ineffective unless some external writer updates `ai-budget:*` or the DO.

### Answer

There is no real enforcement gate for monthly spend today. `monthlyCostCapUsd` is informational/display-only. The UI can say "Budget Exceeded" and claims AI proxy requests will be rejected (`apps/web/src/pages/SettingsComputeUsage.tsx:374`), but the proxy does not check monthly cost.

Recommended fixes:

- Implement the backlog approach: scheduled aggregation of AI Gateway logs into a per-user/month KV or D1 aggregate, with freshness metadata.
- Add a shared `checkAiBudget()` service that checks both enforced daily token limits and cached monthly cost cap.
- Call that service from all AI proxy entry points: `/ai/v1/chat/completions`, `/ai/anthropic/v1/messages`, `/ai/anthropic/v1/messages/count_tokens` if billed, and `/ai/proxy/:wstoken/...`.
- Fix daily token accounting by wiring `incrementTokenUsage()` or replacing the DO daily counter with cached Gateway aggregates.
- Until monthly enforcement ships, change Settings copy so monthly cap is not presented as blocking.

## 2. Compute vCPU-Hour Quota Enforcement

### What exists

- D1 stores compute metering in `compute_usage` with `user_id`, `workspace_id`, `node_id`, `server_type`, `vcpu_count`, `credential_source`, `started_at`, `ended_at`, and indexes on user/period and workspace (`apps/api/src/db/schema.ts:1381`; migration at `apps/api/src/db/migrations/0038_compute_usage.sql:2`).
- `startComputeTracking()` inserts a row when workspace metering starts, with `credentialSource` defaulting to `user`; `stopComputeTracking()` closes open rows by setting `endedAt` (`apps/api/src/services/compute-usage.ts:29`, `apps/api/src/services/compute-usage.ts:60`).
- `calculateVcpuHoursForPeriod()` clamps open/closed intervals to the current month and optionally filters by `credentialSource` (`apps/api/src/services/compute-usage.ts:93`, `apps/api/src/services/compute-usage.ts:101`).
- Quotas are stored in D1 tables `default_quotas` and `user_quotas`, not env vars. The schema comments define default quota and per-user overrides at `apps/api/src/db/schema.ts:1417` and `apps/api/src/db/schema.ts:1431`; migration `0039_compute_quotas.sql` creates those tables.
- `resolveUserQuota()` resolves `user_quotas -> default_quotas -> unlimited` (`apps/api/src/services/compute-quotas.ts:28`).
- `checkQuotaForUser()` checks only current-month `credential_source = 'platform'` usage and returns `allowed: remaining > 0` (`apps/api/src/services/compute-quotas.ts:79`, `apps/api/src/services/compute-quotas.ts:93`, `apps/api/src/services/compute-quotas.ts:102`).
- Enforcement gates exist for platform-credential provisioning:
  - task submission checks quota before queueing/provisioning at `apps/api/src/routes/tasks/submit.ts:236`;
  - manual node creation checks quota at `apps/api/src/routes/nodes.ts:171`;
  - MCP dispatch checks quota at `apps/api/src/routes/mcp/dispatch-tool.ts:417`;
  - TaskRunner node provisioning re-checks quota inside the DO at `apps/api/src/durable-objects/task-runner/node-steps.ts:144`.
- `COMPUTE_QUOTA_ENFORCEMENT_ENABLED` is only a kill switch; quota values themselves are D1/admin-managed (`apps/api/src/env.ts:514`).
- BYOC is exempt by design: enforcement only runs when resolved credential source is `platform`, and usage calculation filters to platform rows.

### What is missing or weak

- There is no reservation or projected-cost check. `checkQuotaForUser()` only tests already-recorded usage. A user with `0.01` vCPU-hours remaining can start a multi-vCPU workspace because `remaining > 0` is enough.
- A user can exceed quota after a workspace starts. The gate blocks new platform-provisioned compute once recorded usage catches up, but it does not stop currently running workspaces when they pass the monthly cap.
- The check is vulnerable to concurrent starts because two requests can both observe positive remaining quota before either new usage row materially increases the total.
- Metering start/stop is best-effort in workspace paths. `apps/api/src/routes/workspaces/crud.ts:324` starts tracking inside a try/catch that logs but does not block workspace creation, so missing metering records can undercount quota.
- The user-facing `byocExempt` flag calls `userHasOwnCloudCredentials(db, userId)` without a target provider in `apps/api/src/routes/usage.ts:57`, so it is informational and can overstate exemption if the user's actual provisioning provider would use platform credentials. Enforcement paths do provider-specific credential resolution.

### Answer

Yes, a user can exceed their compute quota today. They cannot start new platform-provisioned compute after `checkQuotaForUser()` observes `remaining <= 0`, but active workspaces continue running and can push usage past the cap. Small remaining balances, concurrency, and best-effort tracking failures can also allow overrun. Once over quota, new platform-backed task/node provisioning returns a forbidden error; BYOC remains allowed.

Recommended fixes:

- Add quota reservations for pending/running platform provisioning, atomically checked in D1 before node/workspace creation.
- Check projected usage using requested VM vCPU count and expected minimum session duration, not only historical used hours.
- Decide whether over-cap active platform sessions should continue, receive warning, or be automatically stopped after grace.
- Make compute tracking failures block platform workspace creation if quotas/billing depend on those rows.
- In `/api/usage/quota`, compute BYOC exemption against the resolved/default provider where possible, or label it as "has cloud credentials" instead of quota exemption.

## 3. Admin Per-User Override System

### What exists

- Admin user management only lists users and allows approve/suspend plus role changes (`apps/api/src/routes/admin.ts:25`, `apps/api/src/routes/admin.ts:59`, `apps/api/src/routes/admin.ts:102`). It does not expose AI budgets, monthly AI caps, or token limits.
- Admin compute quota routes exist under `/api/admin/quotas`, mounted at `apps/api/src/index.ts:559`.
- Superadmins can set a platform-wide default monthly vCPU-hour quota with `PUT /api/admin/quotas/default` (`apps/api/src/routes/admin-quotas.ts:41`).
- Superadmins can list quota users, get a user's resolved quota, set a per-user compute override, and delete that override (`apps/api/src/routes/admin-quotas.ts:62`, `apps/api/src/routes/admin-quotas.ts:70`, `apps/api/src/routes/admin-quotas.ts:114`, `apps/api/src/routes/admin-quotas.ts:152`).
- The admin UI has a Quotas tab. `AdminComputeQuotas` loads quota data, saves default quota, edits a user's monthly vCPU-hour limit, and removes overrides (`apps/web/src/pages/AdminComputeQuotas.tsx:120`, `apps/web/src/pages/AdminComputeQuotas.tsx:142`, `apps/web/src/pages/AdminComputeQuotas.tsx:169`, `apps/web/src/pages/AdminComputeQuotas.tsx:188`).
- D1 has `user_quotas` for compute. A search found no `user_settings`, `user_overrides`, or `user_tier` tables. Existing `tier` references are AI model catalog labels, not user limit tiers.
- KV has per-user AI budget settings at `ai-budget-settings:{userId}`, but those are written by the current user through `/api/usage/ai/budget`, not by admin routes.

### What is missing

- No admin route or UI can set per-user AI daily input/output token limits.
- No admin route or UI can set per-user AI monthly cost caps.
- No admin route or UI can view or edit another user's `ai-budget-settings:{userId}`.
- No tier system exists for grouping token, cost, and compute limits together.
- The compute admin UI lists users with usage or overrides. If a user has no current compute usage and no override, they may not appear in the Quotas table even though an admin may want to pre-grant them a higher limit.
- There is no precedence model for AI limits. Today user KV settings override env defaults for daily token limits, but admin-managed overrides do not exist.

### Answer

If you are an admin and want to give a specific user higher limits today:

- More compute hours: yes. Use Admin > Quotas to set that user's monthly vCPU-hour override, assuming the user appears in the quota list. The backend supports `PUT /api/admin/quotas/users/:userId` directly.
- More daily AI tokens: not through admin. The user can self-configure daily input/output limits within platform min/max, but the admin has no per-user control.
- Higher monthly AI cap: not through admin, and even the user's self-set monthly cap is display-only because monthly cost is not enforced.

What is needed for the "give a friend higher limits" story:

- A single admin-facing user limits page or modal reachable from Admin > Users.
- D1-backed user limit overrides, or a clearly admin-owned KV namespace, covering daily input tokens, daily output tokens, monthly AI cost cap, and monthly compute hours.
- A documented precedence model, for example admin override -> user self-limit -> default tier -> env/constant.
- Enforcement code paths for all enforced dimensions, especially cached monthly AI cost.
- A user picker/search in Admin > Quotas/Limits so admins can configure users before they have usage.

## 4. AI Gateway Log Aggregation

### What exists

- `fetchGatewayLogs()` calls Cloudflare's AI Gateway logs API with `page`, `per_page`, `start_date`, and ordering params (`apps/api/src/services/ai-gateway-logs.ts:132`, `apps/api/src/services/ai-gateway-logs.ts:141`).
- `iterateGatewayLogs()` loops from page 1 through `maxPages`, sends `per_page`, `start_date`, `order_by=created_at`, and `order_by_direction=desc`, and stops when a short page is returned or `page >= total_pages` (`apps/api/src/services/ai-gateway-logs.ts:167`, `apps/api/src/services/ai-gateway-logs.ts:175`, `apps/api/src/services/ai-gateway-logs.ts:190`).
- Pagination defaults to `pageSize=50` and `maxPages=20`, with a hard cap of 20 pages (`apps/api/src/services/ai-gateway-logs.ts:84`, `apps/api/src/services/ai-gateway-logs.ts:87`, `apps/api/src/services/ai-gateway-logs.ts:89`, `apps/api/src/services/ai-gateway-logs.ts:118`).
- Therefore the intended ceiling is 1,000 log entries per aggregation request. If `AI_USAGE_PAGE_SIZE` is set above Cloudflare's max of 50, the code does not clamp it locally, so the practical behavior depends on the Cloudflare API response; the comment says CF max is 50.
- User usage and budget endpoints aggregate on demand (`apps/api/src/routes/usage.ts:87`, `apps/api/src/routes/usage.ts:181`).
- Admin cost and AI usage dashboards also aggregate on demand (`apps/api/src/routes/admin-costs.ts:122`, `apps/api/src/routes/admin-costs.ts:146`, `apps/api/src/routes/admin-ai-usage.ts:57`, `apps/api/src/routes/admin-ai-usage.ts:92`).

### What is missing

- No incremental cron writes AI Gateway aggregates to D1 or KV.
- No endpoint response includes a "truncated", "maxPagesReached", "entriesScanned", "totalPages", or "freshness" field. A user/admin cannot tell whether totals are complete.
- User filtering happens client-side in the Worker visitor by checking `entry.metadata?.userId`, after fetching global gateway pages. For a high-volume gateway, one user's older entries can fall beyond the first 1,000 global entries even if the requested period is current-month.
- The cost cap budget route reuses the same capped scan, so even display-only monthly cost can be undercounted for high-volume traffic.

### Answer

For a high-volume user or a high-volume shared gateway, cost data is not guaranteed complete or accurate. It is best-effort over at most 20 pages of newest gateway logs from the period. Once the period contains more logs than the pagination ceiling, older entries are omitted and per-user totals can be materially undercounted.

Recommended fixes:

- Add scheduled incremental aggregation keyed by `{month, userId, model}` with idempotent cursors or time windows.
- Store aggregate metadata: last successful sync, entries scanned, known truncation, and source window.
- Clamp `AI_USAGE_PAGE_SIZE` to the Cloudflare max locally.
- If Gateway API supports metadata/server-side filters, use them to query by `userId`; otherwise keep global scan only as a fallback.
- Include completeness/freshness fields in user and admin usage responses.

## 5. User-Facing Usage Visibility

### What exists

- `/api/usage/compute` returns current-month compute usage summary and active sessions (`apps/api/src/routes/usage.ts:39`).
- `/api/usage/quota` returns resolved compute quota, current platform usage, remaining hours, period bounds, and BYOC display flag (`apps/api/src/routes/usage.ts:52`).
- `/api/usage/ai` returns AI Gateway totals by model/day for the current user, filtered by `metadata.userId`, with periods `current-month`, `7d`, `30d`, and `90d` (`apps/api/src/routes/usage.ts:77`, `apps/api/src/routes/usage.ts:118`).
- `/api/usage/ai/budget` returns budget settings, daily token usage, effective daily limits, month cost, utilization percentages, and exceeded flag (`apps/api/src/routes/usage.ts:181`, `apps/api/src/routes/usage.ts:229`).
- Settings > Usage shows:
  - LLM cost, requests, input/output tokens, model breakdown, daily trend (`apps/web/src/pages/SettingsComputeUsage.tsx:58`, `apps/web/src/pages/SettingsComputeUsage.tsx:139`);
  - budget utilization and editable self-service AI budget settings (`apps/web/src/pages/SettingsComputeUsage.tsx:251`, `apps/web/src/pages/SettingsComputeUsage.tsx:350`);
  - compute quota progress and active workspaces (`apps/web/src/pages/SettingsComputeUsage.tsx:494`, `apps/web/src/pages/SettingsComputeUsage.tsx:637`).

### What is missing or misleading

- There is no visibility into aggregation completeness. Users cannot see that AI Gateway usage may be capped at 1,000 newest global entries.
- If AI Gateway errors occur, `/api/usage/ai` returns an empty response for regular users rather than surfacing a partial/unavailable state (`apps/api/src/routes/usage.ts:138`). That can make "no usage" indistinguishable from "usage unavailable."
- Settings says "AI proxy requests will be rejected (429)" for any exceeded budget including monthly cost (`apps/web/src/pages/SettingsComputeUsage.tsx:374`), but monthly cost is not enforced and daily token counters may not be incremented.
- The UI says "Direct BYOK or non-Gateway usage is not tracked" (`apps/web/src/pages/SettingsComputeUsage.tsx:129`). Passthrough BYOK requests that go through SAM's AI Gateway proxy are tracked, so the wording is broadly useful but imprecise.
- Daily token usage comes from the DO/KV counter, while cost/tokens in the LLM Usage section come from Gateway logs. Without a functioning increment path, these numbers may disagree.

### Answer

Users have partial visibility, but not enough to fully trust usage numbers. They can see useful current-month compute usage, quota state, AI Gateway totals, and configured budget values, but they cannot see whether AI totals are complete, whether Gateway log aggregation failed, or which limits are actually enforced. The budget UI currently overstates enforcement for monthly cost.

Recommended fixes:

- Add `complete`, `truncated`, `entriesScanned`, `maxEntries`, and `lastUpdatedAt` fields to AI usage/budget responses.
- Surface Gateway aggregation failures as "temporarily unavailable" instead of empty usage.
- Make budget copy precise: daily tokens enforced only if accounting is working; monthly cost currently informational until enforcement lands.
- Reconcile daily token usage with Gateway token totals or explain why they differ.
- Show tracked traffic categories: platform proxy, passthrough BYOK via Gateway, direct user API calls outside SAM, and non-Gateway traffic.

## Final Conclusions

- Monthly AI cost cap enforcement is display-only.
- Compute quotas are real gates for new platform-provisioned compute, but they are not hard spend caps because active sessions can run past the limit and the check has no reservation.
- Admins can grant per-user compute quota overrides today, but cannot grant per-user AI token budgets or monthly AI cost caps.
- AI Gateway aggregation is on-demand and capped at roughly 1,000 newest log entries per request, so high-volume cost numbers can be incomplete.
- The admin "give a friend higher limits" story is only implemented for compute. A complete story needs admin-owned AI limit overrides plus monthly cost enforcement.
