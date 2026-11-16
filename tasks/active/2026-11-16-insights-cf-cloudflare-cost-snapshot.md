# Insights slice CF: Cloudflare cost snapshot and Health & cost card

Task 01M7K7F2P8MFFVMKCQQ6B2NG5R. Build spec: idea 01M7HTS38KX2G78JD0ESAGMKKH (slice CF). Coordinator
task 01M7JK6W6PRQN64GD2MVMFZKBX, channel `feature.insights`.

## Problem

Admin › Health & cost (slice H, PR #2784) reports compute spend only. The Cloudflare bill (Workers,
Durable Objects, D1, KV, R2, Workers AI, Containers) is invisible in the app; the only estimate is the
`pnpm quality:cloudflare-cost` script, which needs a developer and a production token. Superadmins need
a daily, stored, usage-derived estimate with a month projection, on the page they already use.

## Research findings

- `scripts/quality/check-cloudflare-cost.ts` + `cloudflare-cost-core.ts` + `cloudflare-cost-types.ts`:
  one GraphQL request, 7 datasets, `analyzeCloudflareCost()` builds a daily series per metric and
  `projectMetric()` projects MTD + recent daily average × remaining days (rule 76.4). DO duration is
  `durableObjectsPeriodicGroups.sum.duration` (rule 76.2). It does not price Workers requests/CPU or KV.
- Probed production analytics (2026-11-16):
  - `workersInvocationsAdaptive` has `dimensions.eventType` (`fetch`, `cron`, `tail`, ...). Tail
    invocations (`sam-tail-worker-prod`, 590k/day vs 261k API requests) are excluded from request
    billing by `eventType != tail` (rule 76.5); their CPU time still counts.
  - `kvOperationsAdaptiveGroups` (actionType read/write/delete/list), `kvStorageAdaptiveGroups`
    (max byteCount per namespace) work. `durableObjectsStorageGroups` returns nothing: not priced.
  - Cloudflare refuses any query whose range is wider than 4w4d or whose start is older than 4w4d
    ("quota" error). So one request can cover at most ~31 complete days, and days older than that can
    never be fetched. Backfill bound = 31 days max, one request per run.
- The staging analytics account hosts staging AND staging2 (and the installer): account-level
  analytics are account-wide, as is the script. The card must say it covers the whole account.
- Credential: Worker secrets `CF_API_TOKEN` + `CF_ACCOUNT_ID` already exist. Admin Analytics already
  queries the Analytics Engine SQL API with `CF_API_TOKEN` (`admin-analytics-query.ts`), which needs
  Account Analytics: Read, so production's runtime token is expected to have it. No new secret.
  Self-hosting token table and the hosted installer runtime token do not list Account Analytics Read.
- Slice H: `installationHealth` (packages/operations/src/insights-installation.ts) = 9 round trips +
  3 in the route = 12 of 15. Sections are isolated; failed ones are null + listed in `unavailable`.
- Daily cron `0 3 * * *` runs each daily job as its own `ctx.waitUntil` promise
  (`apps/api/src/scheduled/handler.ts`, 542 lines: over the 500 limit, so split the daily block out).
- Migrations: 0253 (#2811), 0254 (#2818), 0255 (#2821) are taken by open PRs. CF takes 0256.
- Tests apply migration SQL into better-sqlite (`insights-phase-timings.test.ts` pattern).

## Design

- Move the billed-metric core (types, pricing, analysis, GraphQL query/parse) to
  `packages/shared/src/cloudflare-cost/`; the script and the worker both import it. Add Workers
  requests, Workers CPU, KV reads/writes/deletes/lists and KV storage to the one core.
- Table `installation_cost_daily (source, day, product_line, usage_quantity, usage_unit,
  estimated_cost_usd, fetched_at)` PK (source, day, product_line), plus `installation_cost_sync`
  (one row per source: last attempt/success, status, error). Migration 0256, additive.
- Per-day cost: cumulative-allowance metrics charge the day's increase of the month-to-date cost;
  daily-allowance metrics charge the day alone; storage snapshots charge 1/daysInMonth of a month.
  The month's earlier days come from D1 so a row's cost is stable across refetches.
- Job `runCloudflareCostSnapshot` (apps/api/src/services/cloudflare-cost-snapshot.ts): one GraphQL
  request for the last `insights.cloudflareCostBackfillDays` complete days (default 30, max 31),
  one D1 read (month prefix), one D1 batch upsert + status. Unconfigured => status row only.
- Card read in `installationHealth`: one D1 batch (rows since min(month start, series start) +
  status) => 13 of 15 round trips.
- Superadmin `POST /api/admin/health-cost/cloudflare/refresh` + "Refresh now" button (policy 2b97aefc).

## Implementation checklist

- [ ] Shared cloudflare-cost core (types, pricing incl. Workers/KV, analysis, per-day cost, GraphQL)
- [ ] Script uses the shared core; its tests still pass; new metrics in the report
- [ ] Migration 0256 (installation_cost_daily + installation_cost_sync), churning list not needed
- [ ] Settings: backfill days, query limit (job); series days, top lines (card)
- [ ] Job service with error classification (not_configured / permission_denied / error)
- [ ] Daily cron wiring in an extracted daily-jobs module (handler.ts under 500 lines)
- [ ] Superadmin refresh route
- [ ] `cloudflare` section in installationHealth + shared types; round-trip count test updated
- [ ] Web: Cloudflare tile + pane (MTD, projection, top lines, daily series, estimate label,
      unconfigured / permission / error / never-run states, Refresh now)
- [ ] Tests: GraphQL fixture -> rows, idempotent upsert on real SQLite, unconfigured, scheduled
      isolation, projection math, route auth
- [ ] Playwright audit 375/1280: realistic, empty, unconfigured, permission-denied
- [ ] Docs: admin-settings guide, self-hosting token table (Account Analytics: Read, optional),
      env reference note, Health & cost docs
- [ ] Installer runtime token: request Account Analytics Read

## Acceptance criteria

- [ ] Daily job writes one row per complete day per product line, idempotently, tail invocations
      excluded from Workers requests, DO duration from periodic `sum.duration`
- [ ] Rows on staging match `pnpm quality:cloudflare-cost` usage for the same days
- [ ] Card shows MTD, projection (recent-rate), top lines and a daily series, labelled an estimate
- [ ] Unconfigured / no-permission explains what to set; nothing errors
- [ ] A failing snapshot cannot break other daily jobs
- [ ] installationHealth stays within 15 round trips (stated in code and test)

## References

- `.claude/rules/76-cost-decisions-must-query-billed-metrics.md`, rules 47, 53, 60, 81, 31, 22
