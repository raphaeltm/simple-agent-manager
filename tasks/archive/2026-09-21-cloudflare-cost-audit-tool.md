# Cloudflare cost audit quality tool

**Status:** in progress
**Branch:** `sam/build-cloudflare-cost-audit-xd5a04`
**SAM task:** `01M311JZE53D9FDTNZDCXD5A04`

## Problem

SAM project knowledge has told agents to run `pnpm quality:cloudflare-cost` and to consult a
cost-decision rule, but neither exists on `main`. The missing tool led agents to hand-roll
Cloudflare GraphQL queries and confuse the Durable Objects latency field
`durableObjectsInvocationsAdaptiveGroups.sum.wallTime` with the billed duration field
`durableObjectsPeriodicGroups.sum.duration`.

The immediate failure mode is known: an MTD-only read of September 2026 rows-read usage looked like
a rising cost problem, while the daily series showed most usage happened September 1-4 under a
regime that ended September 5. The tool must report daily usage and project the month from a recent
daily rate, not from the running MTD average.

## Research findings

- Recovered the abandoned spec from commit `1878261c8`, which added
  `tasks/backlog/2026-09-13-cloudflare-cost-audit-billed-metrics.md`. Its central finding still
  holds: DO duration cost comes from `durableObjectsPeriodicGroups.sum.duration`, which is
  described by live GraphQL introspection as "Sum of Duration - GB*s"; `wallTime` is a latency
  metric and must not feed cost math.
- Live introspection on 2026-09-21 verified the required account datasets and fields:
  - `durableObjectsPeriodicGroups.sum`: `activeTime`, `duration`, `rowsRead`, `rowsWritten`,
    `storageReadUnits`, `storageWriteUnits`, `subrequests`.
  - `durableObjectsInvocationsAdaptiveGroups.sum.requests` is the DO request-count source. The
    tool must not select `sum.wallTime`.
  - `aiInferenceAdaptiveGroups.sum.totalNeurons` is the Workers AI cost unit.
  - `r2StorageAdaptiveGroups.max.payloadSize` and `metadataSize` provide R2 stored bytes.
  - `d1AnalyticsAdaptiveGroups.sum.rowsRead` / `rowsWritten` and
    `d1StorageAdaptiveGroups.max.databaseSizeBytes` provide D1 usage.
  - `containersUsageAdaptiveGroups.sum.allocatedMemory` provides container byte-seconds; the
    required output covers container memory.
- Current Cloudflare docs checked on 2026-09-21 confirm the allowances/rates used by the tool:
  DO requests 1M/month plus $0.15/M, DO duration 400k GB-s/month plus $12.50/M GB-s, DO/D1 rows
  read 25B/month plus $0.001/M, DO/D1 rows written 50M/month plus $1/M, DO SQL storage 5 GB-month
  plus $0.20/GB-month, D1 storage 5 GB plus $0.75/GB-month, R2 storage 10 GB-month plus
  $0.015/GB-month, Containers memory 25 GiB-hours plus $0.0000025/GiB-second, and Workers AI
  10,000 free Neurons/day plus $0.011/1,000 Neurons.
- `scripts/quality/README.md` documents the quality-script pattern. `scripts/quality` tests run
  under `pnpm quality:scripts:test` using `scripts/quality/vitest.config.ts`.
- The existing `scripts/quality/check-do-wall-time.ts` is a latency regression tool and should stay
  separate. Its GraphQL pattern and CLI error handling are useful examples, but this cost tool must
  not query `wallTime`.
- Root rule `75-external-api-check-then-act.md` already occupies number 75. The new rule should use
  the next free number and a filename that says the actual cost rule.
- The task is scripts/docs/tests/rules only. No Worker runtime or UI code should change, so staging
  deployment is not needed unless scope expands.

## Implementation checklist

- [x] Add `scripts/quality/check-cloudflare-cost.ts` with:
  - [x] fail-closed config for `CF_PRODUCTION_DEBUGGING_TOKEN` and `CF_PRODUCTION_ACCOUNT_ID`;
  - [x] read-only Cloudflare GraphQL queries for DO periodic metrics, DO request counts, Workers AI,
        R2 storage, D1 analytics/storage, and container memory;
  - [x] no use of `/accounts/:id/billable/usage`;
  - [x] no selection or cost use of DO invocation `wallTime`;
  - [x] daily time series output with usage, free allowance, headroom, estimated cost, and
        usage-derived estimate labeling;
  - [x] recent-rate month projection and regime-change flagging from daily usage, not MTD average;
  - [x] `--max-usd=<n>` nonzero budget guard while default remains report-only.
- [x] Export parsing, aggregation, projection, and pricing helpers for fixture-driven tests.
- [x] Add tests for:
  - [x] allowance boundary cost math;
  - [x] `duration == activeTime * 0.128` identity checks;
  - [x] hibernating WebSocket shape where huge `wallTime` does not affect cost;
  - [x] September 2026 shape where first four days dominate and recent-rate projection does not
        report "climbing";
  - [x] missing credential and GraphQL error fail-closed behavior;
  - [x] `--max-usd` exit behavior.
- [x] Register `quality:cloudflare-cost` in root `package.json`.
- [x] Document the script and metric choices in `scripts/quality/README.md`.
- [x] Add a new compact root rule for billed Cloudflare cost metrics, including the daily-series
      requirement and the DO `duration` vs `wallTime` distinction.
- [x] Update any stale SAM knowledge/rule references in repository docs or agent steering files.
- [x] Leave `apps/api/src/durable-objects/notification.ts` and `notification-push.ts` untouched.
- [x] Run relevant quality checks and full `/do` validation gates.

## Acceptance criteria

- [x] `pnpm quality:cloudflare-cost` is wired and prints a usage-derived daily and projected monthly
      estimate for production Cloudflare usage.
- [x] Durable Object duration uses `durableObjectsPeriodicGroups.sum.duration`; request billing does
      not include tail invocations; no cost path uses `durableObjectsInvocationsAdaptiveGroups.sum.wallTime`.
- [x] The report includes DO duration/rows/storage units/requests, Workers AI neurons net of daily
      allowance, R2 storage, D1 rows/storage, and container memory, each with usage, allowance,
      headroom, and estimated dollars.
- [x] The September 2026 regression fixture projects from the recent rate and does not classify the
      month as climbing when the first four days dominate.
- [x] Missing credentials or GraphQL errors fail visibly with exit code 2 and never emit partial zeros.
- [x] Tests are fixture-driven and do not require live Cloudflare credentials.
- [x] Documentation and the new rule explain the metric choices so the next agent does not re-derive
      them.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass, or any repo-existing unrelated
      failure is documented with direct evidence.

## Review findings

- task-completion-validator: PASS. The recovered spec, research findings, implementation checklist, diff, fixture tests, live read-only run, and full validation commands align with the acceptance criteria. No Worker runtime or UI files changed.
- cloudflare-specialist: PASS. The tool uses account-level GraphQL analytics only, never `/accounts/:id/billable/usage`; DO cost uses `durableObjectsPeriodicGroups.sum.duration`; request billing comes from invocation `requests`; the query fails closed on GraphQL errors and possible pagination truncation.
- constitution-validator: PASS. Cloudflare endpoint, query limit, recent-day projection window, allowances, and rates are configurable through environment variables while documented defaults mirror Cloudflare pricing units.
- security-auditor: PASS. The debugging token is required from the environment, used only in the Authorization header, never logged, and the script is read-only.
- doc-sync-validator: PASS. Root quality README and the new compact cost-metric rule document command usage, credentials, metric choices, daily projection, and known billing caveats. No runtime deployment docs need updates for a local quality script.
- test-engineer: PASS. Tests are fixture-driven, require no live Cloudflare credentials, and cover cost math, DO duration identity, hibernating WebSocket wall-time regression, early-spike projection, fail-closed paths, default window, and budget exit behavior.

## Validation results

- `pnpm exec vitest run --config scripts/quality/vitest.config.ts scripts/quality/check-cloudflare-cost.test.ts` passed: 8 tests.
- `pnpm quality:cloudflare-cost` passed against production analytics read-only on 2026-09-21; default window 2026-09-01 through 2026-09-20 projected DO rows read at 22.92B, under the 25B allowance, with early-spike trend.
- `pnpm quality:scripts:test` passed: 47 files, 636 tests.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passed before the final constant-import cleanup.
- `pnpm lint && pnpm typecheck` and the focused cost-audit Vitest suite passed after the final cleanup.

## References

- Abandoned spec: commit `1878261c8`, `tasks/backlog/2026-09-13-cloudflare-cost-audit-billed-metrics.md`
- `scripts/quality/README.md`
- `scripts/quality/check-do-wall-time.ts`
- `.claude/rules/03-constitution.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`
- Cloudflare Durable Objects / Workers / D1 / R2 / Containers / Workers AI pricing docs checked 2026-09-21
