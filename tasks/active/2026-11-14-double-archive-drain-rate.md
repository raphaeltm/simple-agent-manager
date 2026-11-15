# Double ProjectData archive drain rate

## Problem

The SAM root is at 92% storage with approximately 4.75M messages awaiting archive.
Approved 2026-11-14: halve cadence to 540000 ms and raise daily reservations to 6000000.

## Research

Production GitHub Environment pins budget 2400000 (2026-09-27); no interval override.
Staging has no archive overrides. Rule 70 requires deployed binding evidence.
Shipped test constants and cadence-dependent assertions need updating; dated audit snapshots and local fixtures remain historical.
Measurement idea: 01M7CX61WVX72T7CFQNRTX0DVM; notes 01M7DMSHEZKW7F7W23ZS4B8Q1A and 01M7DNBWR1VM5G3A99YAJGCF8P.

## Checklist

- [x] Set only budget and interval in wrangler; update explanatory comments and configuration docs.
- [x] Update shipped assertions; retain local/historical fixtures; run quality checks.
- [x] Local completion, Cloudflare/environment, documentation, constitution and test reviews.
- [ ] Deploy shared staging branch; verify plain-text bindings and natural cron cadence.
- [ ] PR CI and CodeRabbit request/wait; record throughput and load review.
- [ ] Immediately before merge change only production budget override; record old/new/time.
- [ ] Verify successful production receipt containing commit, bindings and deploy override reporting.
- [ ] Observe >=4 ticks, failures/refusals, root continuity, and first two hours copied rows.
- [ ] Post measured note on idea and durable message to parent.

## Acceptance

Config-only: no archive logic, wall-time, factor, sessions or storage gate changes.
36k/h => 131.94h / 5.50d; target 72k/h => 65.97h / 2.75d, excluding inflow.
18m rounds to ~20m; 9m rounds to ~10m on 5m cron; per-tick wall bound stays 60s.
If billed writes equal reservation units, 6M is ~$6/day at $1/M, +$3.60/day vs 2.4M.
This ceiling-equivalent comparison is not a measured billing cap; expected writes cost ~$2.4-$4.4/day.
Expected writes 2.38M-4.44M/day at 1.38-2.57 writes/raw row, under 3d; D1/R2/compute separate.

## Workflow

Primary checkout and assigned output branch per user; no external worktree or main task-only commit.
Keep task active until post-release observations complete.

## Local validation
Full lint (22 tasks), typecheck (36 tasks), test (39 tasks), build (18 tasks) pass.
API: 1014 files / 15178 tests pass, 3 files / 4 tests skipped.
Shipped-value suites: 13 pass; real Worker drain-relief: 17 pass.
Local reviews: Cloudflare/environment/constitution PASS; completion/docs/test findings addressed.
