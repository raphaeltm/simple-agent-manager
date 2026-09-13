# Cloudflare cost audit: measure the billed metric, not `wallTime`

**Status:** in progress
**Branch:** `sam/cut-notificationservice-durable-objects-9gfprd`
**SAM task:** 01M2CNV60FNVCVZH1J6C9GFPRD
**Origin:** dispatched as "Cut the NotificationService Durable Object's billed wall time, which is
36% of SAM's Durable Object duration bill." Step 1 of that task was "measure before theorising"
(rule 39). The measurement refuted the premise. This file records the measurement, the refutation,
and the deliverable that replaces the requested change.

## Problem

The dispatch asserted that the `NotificationService` Durable Object bills 43.3 wall-hours/day —
36% of SAM's DO duration bill — and asked for push-delivery changes to cut it, with the goal of
bringing the Cloudflare bill under $15/month.

**The premise is false.** The 43.3 h/day figure came from
`durableObjectsInvocationsAdaptiveGroups.sum.wallTime`, which is not the duration billing metric.
`NotificationService` bills **55 GB-s** in September month-to-date — **0.036%** of DO duration —
and DO duration in total is **under the free allowance**, so it costs **$0.00**.

## Research findings

All figures: production account (`CF_PRODUCTION_ACCOUNT_ID`), Cloudflare GraphQL, queried
2026-09-13T06:20Z. Month-to-date window is 2026-09-01T00:00Z → 2026-09-13T06:20Z (12.26 days);
"projected" multiplies by 30/12.26 = 2.447.

### F1. `duration` is the billed field; `wallTime` is not

GraphQL introspection of `AccountDurableObjectsPeriodicGroupsSum` returns a field described
literally as `duration: Sum of Duration - GB*s`. The same dataset exposes `activeTime`
("Sum of active time - microseconds").

Verified identity across every namespace — `duration == activeTime × 0.128` exactly
(128 MB is the DO billing memory unit):

| namespace | `duration` (GB-s, 7d) | `activeTime × 0.128` |
|---|---|---|
| ProjectData | 33,914 | 33,914 |
| VmAgentContainer | 14,269 | 14,269 |
| TaskRunner | 1,985 | 1,985 |
| GitHubUserAccessTokenLock | 377 | 377 |

`durableObjectsInvocationsAdaptiveGroups.sum.wallTime` is a *different* dataset and is described
only as "Sum of wall time". For an object using the WebSocket **hibernation** API it accrues for
the entire lifetime of an open connection while the object is hibernated and billing nothing.

### F2. Direct proof of the divergence, from production

`NotificationService` (namespace `9f3e6e63…`), hourly:

| hour (UTC) | requests | `wallTime` | `wallTime`/req | `activeTime` |
|---|---|---|---|---|
| 2026-09-12T20:00Z | 10 | 11,976 s | 1,197.6 s | **0.02 s** |
| 2026-09-13T01:00Z | 3 | 1,859 s | 619.7 s | **0.09 s** |
| 2026-09-12T23:00Z | 5 | 952 s | 190.4 s | **0.09 s** |
| 2026-09-11T22:00Z | 240 | **0 s** | 0 s | 0.22 s |
| 2026-09-12T00:00Z | 240 | **0 s** | 0 s | 0.19 s |

`wallTime` is uncorrelated with request count: hours with 240–250 requests record 0 s, and hours
with 3–10 requests record thousands of seconds. It is tracking how long browser tabs held the
notification socket open. Over 7 days the two metrics diverge by **6,566x** for this namespace —
`ctx.acceptWebSocket` (`apps/api/src/durable-objects/notification.ts:619`) working correctly is
precisely what produces the divergence.

### F3. Billed DO duration by class (Sept MTD)

| class | GB-s MTD | share |
|---|---|---|
| ProjectData | 126,720 | 82.8% |
| VmAgentContainer | 21,966 | 14.4% |
| TaskRunner | 3,014 | 2.0% |
| GitHubUserAccessTokenLock | 636 | 0.4% |
| NodeLifecycle | 400 | 0.3% |
| AdminLogs | 167 | 0.1% |
| **NotificationService** | **55** | **0.036%** |
| AiTokenBudgetCounter | 12 | <0.01% |
| **total** | **152,970** | → ~374,000 projected |

Workers Paid includes **400,000 GB-s/month** (verified against
`https://developers.cloudflare.com/durable-objects/platform/pricing/`). DO duration bills **$0.00**.

### F4. The notification push path already implements the requested fixes

`apps/api/src/durable-objects/notification-push.ts` already: prunes subscriptions on 404/410
(`kind: 'gone'` → `DELETE FROM push_subscriptions`), enforces a 25 s per-notification delivery
budget (`DEFAULT_WEB_PUSH_DELIVERY_BUDGET_MS`, hard-capped by `MAX_WEB_PUSH_DELIVERY_BUDGET_MS`),
fans out with bounded concurrency (`DEFAULT_WEB_PUSH_FANOUT_CONCURRENCY` = 8), caps attempts at 3,
and clamps every `Retry-After` sleep to the remaining budget — returning `failure` rather than
sleeping past the deadline. There is no unbounded retry loop and no uncapped sleep.

### F5. Where the money actually goes

Verified against the Cloudflare pricing pages for Workers, Durable Objects and Containers.

| line | projected monthly | included | est. $/mo |
|---|---|---|---|
| Workers Paid base | — | — | **5.00** |
| Containers memory | 1,608,285 GiB-s | 90,000 GiB-s | **3.80** |
| DO requests | 13.76M | 1M | **1.91** |
| DO SQL storage | ~13.9 GB | 5 GB | **1.78** |
| Containers CPU | 52,974 vCPU-s | 22,500 vCPU-s | **0.61** |
| R2 storage | 47.9 GB | 10 GB | **0.57** |
| Workers CPU | 51.1M CPU-ms | 30M CPU-ms | **0.42** |
| Containers disk | 3,216,626 GB-s | 720,000 GB-s | **0.17** |
| DO duration | 374,317 GB-s | 400,000 GB-s | 0.00 |
| DO rows written | 46.3M | 50M | 0.00 |
| DO rows read (steady state) | ~8.0B | 25B | 0.00 |
| Workers requests | 5.06M | 10M | 0.00 |
| D1 rows read / written | 2.06B / 8.8M | 25B / 50M | 0.00 |
| KV, R2 operations | well under | — | 0.00 |
| **steady-state total** | | | **≈ $14.26** |

**The steady-state bill is already under the $15 target.** `NotificationService` contributes
about **$0.01/month** of it (55 GB-s duration + 78,697 DO requests + 0.001 GiB storage).

Two things that are true but not what the dispatch described:

- **September carries a one-time ~$23.60 DO rows-read charge** from the archive drain: 10.2B rows
  on 09-01 and 4.7B on 09-02 out of 19.85B MTD. Since 09-05 reads run ~266M/day (≈8B/month), under
  the 25B allowance. This is already spent and not recurring.
- **`sam-tail-worker-prod` is invoked once per Worker *and* once per DO invocation** — 7,686,813
  tail invocations MTD vs 2,060,354 `sam-api-prod` + 5,624,300 DO = 7,684,654. It is *not* a
  Workers-requests cost: Cloudflare bills Tail Workers by CPU time, not request count
  (`https://developers.cloudflare.com/workers/observability/logs/tail-workers/`), and its CPU is
  1.40M CPU-ms MTD. Worth knowing, not worth cutting.

### F6. The repo has no tool that reads the billed fields

`scripts/quality/check-do-wall-time.ts` exists, but it is a **latency** regression check: it
compares `wallTimeP99` between windows and defaults to `DO_WALL_TIME_INVOCATION_TYPES=['alarm']`.
It is correctly scoped for what it does, and it does not claim to be a cost tool — but it is the
only "wall time" vocabulary in the repo, and nothing reads `duration`, `rowsRead`, `rowsWritten`,
`containersUsageAdaptiveGroups`, or the plan allowances. An agent asked "what does SAM's Cloudflare
bill look like?" has to hand-roll GraphQL and pick a field, which is exactly how this task was
created.

## Decision

**Do not make the requested change.** Editing `notification.ts` / `notification-push.ts` would
save $0.00, and driving the `wallTime` number down means dropping browsers' notification
WebSockets — degrading real-time notifications to improve a number nobody is billed for.

Deliver instead the thing that makes the question answerable and stops the misdiagnosis recurring.

## Implementation checklist

- [ ] Add `scripts/quality/check-cloudflare-cost.ts`: query the **billed** fields for every
      Cloudflare product SAM uses (DO duration/requests/rows/storage, Containers memory/CPU/disk/
      egress, Workers requests/CPU, D1 rows + storage, KV operations, R2 operations + storage),
      apply the Workers Paid included allowances, and print a per-line dollar estimate sorted by
      cost, plus a per-Durable-Object-class duration breakdown.
- [ ] Make every rate and allowance a named exported constant (constitution Principle XI) with
      env-var overrides, so a plan/price change is a config edit and not a code hunt.
- [ ] Support `--max-usd=<n>` to exit non-zero when the projected total exceeds a budget, so it can
      become a scheduled guard later. Default is report-only (exit 0).
- [ ] Refuse to report `wallTime` as a cost anywhere; print an explicit note that `wallTime` is a
      latency metric and `duration` is the billed one.
- [ ] Add `scripts/quality/check-cloudflare-cost.test.ts` covering: the allowance boundary (under →
      $0, over → charged), the `duration == activeTime × 0.128` identity, a hibernating-WebSocket
      fixture where `wallTime` is huge and `duration` is ~0 (asserting the report bills ~$0), rate
      overrides, `--max-usd` exit codes, and GraphQL error propagation.
- [ ] Register `quality:cloudflare-cost` in root `package.json`.
- [ ] Document it in `scripts/quality/README.md` — including that it is on-demand, needs a token
      with Account Analytics read, and is not a CI gate.
- [ ] Add a compact root rule `.claude/rules/75-cost-decisions-must-query-the-billed-metric.md`
      capturing the class, and route it from `.claude/rules/00-rule-routing.md` if needed.
- [ ] Leave `apps/api/src/durable-objects/notification.ts` and `notification-push.ts` untouched.
- [ ] Update SAM knowledge (`ProductionCostInvestigation`) with the verified per-line breakdown.

## Acceptance criteria

- [ ] `pnpm quality:cloudflare-cost` prints a per-line monthly dollar estimate for the production
      account and a per-class DO duration table, from the billed fields only.
- [ ] Unit tests prove the allowance boundary, the `duration`/`activeTime` identity, and that a
      hibernating-WebSocket fixture with enormous `wallTime` produces a ~$0 duration line.
- [ ] The script reports zero cost for a namespace whose `wallTime` is large but `duration` is
      small — the exact case that produced this task.
- [ ] `.claude/rules/75-…` states the rule, the divergence proof, and the compliance check.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass.
- [ ] No change to notification delivery behaviour (no diff under `apps/api/src/durable-objects/`).

## References

- `.claude/rules/39-debug-before-redesign.md` — measure before proposing a redesign
- `.claude/rules/74-proxy-signals-must-match-the-condition.md` — a gate must key on its condition,
  not a signal that merely correlates. This task is that rule applied to a *diagnosis*.
- `.claude/rules/03-constitution.md` — Principle XI, no hardcoded values (rates/allowances)
- `scripts/quality/check-do-wall-time.ts` — the existing latency check, unchanged by this task
- Cloudflare pricing: Durable Objects, Containers, Workers (all cited inline above)
