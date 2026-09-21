# Cost Decisions Must Query Billed Metrics

## When This Applies

Any Cloudflare cost diagnosis, forecast, optimization task, or spend-related PR rationale for SAM.

## Hard Requirements

1. **Run the cost tool first.** Use `pnpm quality:cloudflare-cost` for production Cloudflare usage
   estimates. The tool reads production analytics with `CF_PRODUCTION_DEBUGGING_TOKEN` and
   `CF_PRODUCTION_ACCOUNT_ID`. If either credential is absent, stop and report that the estimate
   cannot be produced; do not hand-wave missing data into zeros.
2. **Durable Object duration cost comes from `durableObjectsPeriodicGroups.sum.duration`.** This is
   Cloudflare's "Sum of Duration - GB*s" billed field. The companion identity is
   `duration == activeTime / 1_000_000 * 0.128`, because `activeTime` is reported in microseconds
   and Durable Objects bill against a 128 MB memory allocation.
3. **Never price Durable Object duration from
   `durableObjectsInvocationsAdaptiveGroups.sum.wallTime`.** `wallTime` is a latency metric. For
   hibernating-WebSocket objects it can count open connection lifetime while the object is not
   billing duration. NotificationService showed this failure class directly: about 51 wallTime
   hours/day against about 0.0097 billed hours/day, a 5,287x divergence.
4. **Always inspect a daily time series.** Month-to-date totals alone are not enough. On
   2026-09-21, DO `rowsRead = 21.28B` against a 25B allowance looked like a rising cost problem
   until the daily series showed 17.66B of those reads happened September 1-4 under a regime that
   ended September 5. Project the month from the recent daily rate plus usage already spent, not
   from the running month-to-date average.
5. **Exclude tail invocations from request billing.** Tail Workers have their own billing model.
   They must not be counted as ordinary Worker or Durable Object request cost.
6. **Do not use `/accounts/:id/billable/usage` as a dependency.** The production debugging token
   returns 403 there. Reports are usage-derived estimates, not invoice reconciliation.

## Compliance Check

- [ ] `pnpm quality:cloudflare-cost` output or a documented credential failure is included.
- [ ] The report includes the daily series and recent-rate projection.
- [ ] DO duration cost uses `durableObjectsPeriodicGroups.sum.duration`.
- [ ] DO invocation `wallTime` is not selected or used for cost.
- [ ] Tail invocations are excluded from request billing.
- [ ] The conclusion distinguishes usage-derived estimates from invoice lines.
