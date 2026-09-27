# Triple the ProjectData archive drain speed

## Problem

Raphaël asked on 2026-09-27: "Let's speed up the cleanup. Triple the speed." The SAM root
ProjectData Durable Object (`01KHRJGANBBWGDY1NZ0KVF0D4J`) sits at 9.893 GB, 98.9% of its 10 GB
configured limit. The archive drain shrank it ~120 MB/day from 09-24 to 09-26, but a heavy night of
agent work on 09-26 22:00–02:00Z added 87 MB and erased ~25 hours of progress. The drain moves about
one session per hour, which only outpaces growth on quiet days.

## Research Findings

- **The binding constraint is one candidate per sweep tick.** `processArchiveMigrationBatch`
  (`apps/api/src/scheduled/project-data-archive-sharding.ts:3964`) checks
  `PROJECT_DATA_ARCHIVE_WALL_TIME_MS` (shipped `10000`) only BETWEEN candidates. Sampled production
  migrations on 09-25 took 43–83 s each (`totalMs`, ≈8.0–8.4k messages, 3–18 MB reclaimed), so every
  tick archives exactly one session. `PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS` does not bind (see its
  `wrangler.toml` comment), so sessions/day = sweep ticks/day.
- **Ticks are cadence-gated on the five-minute cron.** `scheduled/handler.ts:204` runs the sweep on
  every `*/5` tick; `claimGlobalSweepCadence` claims only when `now >= last_started_at + interval`.
  With the shipped `3600000`, 37 claims between 09-25 12:22Z and 09-27 03:02Z averaged 62.7 min
  apart: the archive step starts 1m15s–3m30s into each cron invocation, so a claim often misses its
  tick by seconds and waits five more minutes.
- **The daily write budget would cap a faster cadence.** Production reserved 17,784–27,106 estimate
  units per migration (six sampled `write_budget_reserved` events; 62,480 for the first three
  migrations of 09-27). 72 migrations/day ≈ 1.55M units, above the shipped 800,000 allowance, which
  would stop the drain at ~38/day (≈1.6×). The per-candidate selection ceiling stays
  `min(SWEEP_MESSAGE_BUDGET=10000, derived)` = 10000 at either allowance, so raising the allowance
  does not change WHICH sessions are selectable (no selection widening, rule 47 §4).
- **Override (rule 70).** The production GitHub Environment pins
  `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET=800000`; it wins over `wrangler.toml` at deploy time and
  must be updated in lockstep. No override exists for `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS`
  in production; staging has no archive overrides. The bot token can write Environment variables
  (verified with a same-value PATCH, 204).
- **Cost (rule 76, `pnpm quality:cloudflare-cost`, 2026-09-27).** DO SQLite rows written: 29.45M
  MTD, 32.79M projected for September against the 50M included allowance; recent days
  0.61–1.01M/day. Tripling adds ≈0.37–0.61M billed rows/day (7.6k–12.6k billed rows per migration
  from the measured 0.74–1.23 billed-rows-per-unit ratio). Expected monthly total 35–46M → $0.
  Worst case (entire 2.4M allowance spent at the highest ratio) ≈1.44M archive rows/day → ~63M/month
  → ~$13/month over the allowance; the allowance itself is the cap. DO rows read headroom 2.34B;
  the extra ~2–3M rows/day of copy/hash reads is negligible.
- **Shipped-value tests.** `sweep-message-budget-shipped.test.ts` hardcodes `TICKS_PER_DAY = 24`,
  and `write-budget-shipped-factor.test.ts` pins `previous === 12` (factor 8 under the historical
  800k allowance) and `shipped >= 24`. The Worker throughput test's `sweepEnv` hardcodes the
  deployed allowance `'800000'`.

## Implementation Checklist

- [x] `apps/api/wrangler.toml`: `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS` `3600000` → `1080000`
      (18 min: always due at the fourth five-minute tick despite the observed start jitter, never
      at the third) with a comment giving the evidence
- [x] `apps/api/wrangler.toml`: `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET` `800000` → `2400000` with
      the cost evidence in its comment; fix "hourly" wording in the adjacent message-budget comment
- [x] Test helper `shippedSweepTicksPerDay()` in `tests/helpers/shipped-archive-budget.ts`, used by
      both shipped-value tests instead of a hardcoded 24
- [x] `write-budget-shipped-factor.test.ts`: keep the factor-8 calibration against a named
      historical 800k allowance; assert the shipped allowance clears every shipped tick
- [x] `sweep-message-budget-shipped.test.ts`: derive ticks/day; update the override note
- [x] `SHIPPED_DAILY_WRITE_BUDGET` in `tests/helpers/archive-sweep-ceiling.ts`, pinned to
      `wrangler.toml` by a unit case and used by the Worker test's `sweepEnv`
- [x] Docs: `apps/www/.../reference/configuration.md`, `.claude/skills/env-reference/SKILL.md`,
      `apps/api/.env.example` shipped values (and the stale "ships 4" / "ships 5000" notes)
- [ ] Production GitHub Environment `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET` → `2400000`
      immediately before merge (recorded in the PR body)
- [ ] Post-deploy: deployed `plain_text` bindings show both values; cadence row
      `next_eligible_at − last_started_at = 1080000`; archive publications ≈3/hour; no new
      storage-reset / RPC-cancellation burst on the SAM object

## Acceptance Criteria

- [ ] The deployed Worker runs with `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS=1080000` and
      `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET=2400000` (script-settings API, not the diff)
- [ ] Production archives ≈3 SAM sessions per hour in the first hours after deploy (D1
      `project_data_archive_migrations`), versus ≈1/hour before
- [x] Shipped-value tests fail if the cadence is raised without a matching allowance (the old
      800k allowance against 72 ticks/day must redden `write-budget-shipped-factor.test.ts`).
      Verified 2026-09-27: budget-only revert reddened 3 cases (`expected 37 to be greater than or
      equal to 72`, `expected 800000 to be 2400000`, `expected 35 to be greater than 72`);
      cadence-only revert reddened `raises the daily message ceiling` (`expected 54 to be less than 24`).
- [x] All docs quoting the shipped values match `wrangler.toml` (`git grep` for the old shipped
      values outside `tasks/archive` returns nothing)

## References

- `apps/api/.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`
- `.claude/rules/76-cost-decisions-must-query-billed-metrics.md`
- `apps/api/.claude/rules/47-control-loop-io-budget.md`
- `tasks/archive/2026-09-20-archive-sweep-throughput-step3.md` (previous throughput step, PR #2109)
