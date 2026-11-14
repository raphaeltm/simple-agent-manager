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
- [ ] At least 30 full-file runs normally and 30 under bounded CPU load; record exact counts.
- [ ] Relevant lint/typecheck/build and archive regression checks.
- [ ] Local test-engineer, Cloudflare and completion reviews; resolve findings.
- [ ] Draft PR with needs-human-review; test-only staging skip explicitly recorded.
- [ ] CI/review evidence sent to coordinator with full SHA; stop without merge.

## Constraints

Use SAM-provided output branch and isolated workspace. No config/migration/production changes planned.
Push each unit. Keep commands under 10 minutes. Do not archive until completion approved.

## References

`.claude/rules/62-tests-must-observe-the-real-trigger.md`, #2700, #2702;
`packages/project-data/src/scheduled/project-data-archive-sharding.ts`;
`packages/project-data/src/do/archive-sharding.ts`.

## Validation in progress

Initial full Workers file: 15/15 passed. Repository lint: 22/22 tasks passed (existing web warnings).
Local test-engineer and Cloudflare review: PASS; completion audit awaits mutation/stability/CI evidence.

Mutation proof on final test code9d5fc49a8 (source and dist changed temporarily, restored byte-for-byte):
- Renewal disabled with early return: lease test fails at line509, only1 distinct expiry vs required >3.
- Poison threshold disabled: poison test fails at line590, fourth state is failed instead of poisoned.
Six fresh full-file reruns on final test code passed15/15 each before mutations. Remaining normal/stress
runs execute after restoration. Root unit command bounded at540s:38 tasks passed, API suite incomplete
after305 files, no observed failures; do not report full pnpm test success.
