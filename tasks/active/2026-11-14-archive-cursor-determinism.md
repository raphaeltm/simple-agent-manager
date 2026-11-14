# Deterministic resumable archive cursor tests

Idea: 01M7BXK7EST9F0H8CZGWYF1DB3. Task: 01M7BY5N87SGN5QNGXZNDJH8A7.

## Problem and research

Required Durable Object Workers CI intermittently fails unrelated PRs (#2605, #2715, #2717, #2718).
The lease test assumes 40 ms per put guarantees >1.2 s of copying before a 2 s deadline;
setup and RPC costs also consume that deadline and a 400 ms lease. Scheduler speed can stop
copying early. Job 132293831140 failed the puts.size * 40 assertion at line 498
(28 puts = 1120 ms), while the actual elapsed-time assertion on line 497 passed. Renewal is checked between operations and deliberately cannot resurrect an expired lease.

Job 132287931176 actually failed the global verifiedChunks assertion, not the poison state sequence.
The four expected states passed. At 01:56:20.090Z, a previous lateedit fixture migrated 600 messages,
crediting 86 verified chunks. Delayed DO summary syncs repopulate D1 after fixture cleanup.
Also, verification completed before a thrown flip is not added to sweep stats (only successful
migration return values aggregate it). Global sweep counters cannot prove this session's read behavior.
Production's persisted complete verdict and no-progress poison logic behave as designed.

## Checklist / acceptance

- [x] Replace lease elapsed-time assumptions with Date-only controlled clock and persisted lease observations.
- [x] Observe real verification results per session; positively prove first verification and zero later re-verification.
- [x] Freeze poison-test wall clock so a slow runner cannot split its first claim.
- [x] Remove renewal and poison guards separately; intended tests fail, then restore and pass.
- [x] At least 30 full-file runs normally and 30 under bounded CPU load; record exact counts.
- [x] Relevant lint/typecheck/build and archive regression checks (full repository unit timeout noted below).
- [x] Local test-engineer, Cloudflare and completion reviews; resolve findings.
- [ ] Draft PR with needs-human-review; test-only staging skip explicitly recorded.
- [ ] CI/review evidence sent to coordinator with full SHA; stop without merge.

## Constraints

Use SAM-provided output branch and isolated workspace. No config/migration/production changes planned.
Push each unit. Keep commands under 10 minutes. Do not archive until completion approved.

## References

`.claude/rules/62-tests-must-observe-the-real-trigger.md`, #2700, #2702;
`packages/project-data/src/scheduled/project-data-archive-sharding.ts`;
`packages/project-data/src/do/archive-sharding.ts`.

## Stability-discovered sibling timing assumption

Initial bounded runs on CPUs0-7 found the existing first large-session test exhausted60 real150ms ticks
under CPU pressure (state copying/recovery_manifest_persisted rather than published), while both
repaired tests passed. This is the same scheduler-budget assumption, not a production race.
The first test now advances Date25ms per real R2 write: six writes consume each150ms tick,
retaining every existing readability/fencing/reservation/no-duplicate assertion and the60-tick bound.
Date cleanup uses Vitest onTestFinished. Full file smoke passed15/15 after this change.
Earlier exploratory repetitions are excluded from the final stability count.

- [x] Control the sibling large-session test's clock; preserve all assertions and tick bound.
- [x] Re-run renewal/poison mutations and additionally remove the yield guard to prove the sibling test.

## Stability-discovered fixture lifecycle race

The v2 repetition proof stopped on normal batchB3: the later budget-refund case migrated its own
small session but also failed an old fixture with a source-intent identity mismatch. Deleting old
D1 journals is insufficient while finished DOs retain pending summary debounce callbacks. Those
callbacks can restore candidate summaries after isolation, leaving source intents with no journal.
The test double now supports retiring summary syncs: disable future writes and await the existing
serialized write-back chain. Every seeded source registers retirement in onTestFinished, so real
summary behavior remains active throughout each test, including the poison case's explicit decoy.
No production archive behavior changes. The final stability proof uses v3 prefixes.

Separate telemetry follow-up (outside this test-only change): idea01M7C1MHXM1B8S9XJ89Y9V5T7A
tracks verifiedChunks omitting verification work before an eventual migration exception.

## Final implementation validation

Implementation `edcb25580` includes all clock, observation, and fixture retirement changes.
The full-file smoke passed 15/15; final API typecheck and changed-file ESLint passed.
Repository lint passed 22 tasks; typecheck/build passed 40 tasks. The full repository unit command
was bounded at 540 seconds: 38 tasks passed; API suite unfinished after 305 files with no observed
failures. ProjectData passed 528 tests/50 files; web passed 5,211 tests/408 files. Full unit success
is not claimed; required CI runs independently.
All 3 mutations were repeated on this exact implementation, each failing only the intended
assertion (1 failed/14 skipped); production source and built module restored byte-for-byte.
Final proof counts only v3nA/B and v3sA/B batches, excluding smoke and every exploratory run.
Final proof: 30/30 normal + 30/30 CPU-loaded full-file runs passed (900/900 tests), each 15 tests
and zero unhandled errors, with no retries. Ten batches per mode each executed 3 runs, all foreground
commands bounded 540 seconds and exit0. Normal processes pinned to CPUs 0–1/2–3; CPU-loaded processes pinned to CPUs 4–5/6–7
with one busy Worker thread each, terminated on command exit. Earlier v1/v2 counts and v3smoke excluded.
Local test-engineer, Cloudflare and implementation completion reviews PASS. External PR/CI/review
gates are tracked in the PR body; the mandatory coordinator hold keeps this task active and unarchived.

The mandatory needs-human-review label intentionally fails Specialist Review Evidence CI.
Preserve the label and report this coordinator hold separately from executable test/build checks.
No merge, readiness transition, deployment or label removal is authorized before exact-SHA approval.
