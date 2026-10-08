# Bound ProjectData storage cleanup and isolate failures

## Problem
SAM root ProjectData storage_safety has repeatedly failed with SQLITE_NOMEM since October 4. Grouped FTS candidate selection aggregates content before LIMIT; failures block downstream cleanup and can roll back alert dedupe markers. Raw transcript retention must remain unchanged.

## Research
- grouped-fts-cleanup.ts joins all eligible grouped content before GROUP BY/LIMIT; session index exists on grouped(session_id, created_at).
- storage-alarm.ts sequentially runs measurement, tool cleanup, grouped cleanup, event cleanup, health telemetry without substep isolation.
- durable-object-retry.ts separates mutation retry from explicitly idempotent operations; NOMEM is unclassified.
- Production binding verified true October 8; no staging/production GitHub Environment override found. Production platform_errors confirms ACP activity NOMEM 500s.
- Real SQLite DO coverage exists in project-data-storage-safety.test.ts.

## Checklist
- [x] Bound session selection and per-session content size inspection; cursor advances over empty/oversized candidates.
- [x] Isolate and log each storage safety substep; preserve prior committed markers on failure.
- [x] Classify SQLITE_NOMEM; retry only explicitly safe idempotent operations.
- [x] Real SQLite alarm-path tests, bounded-query evidence, discriminating negative controls.
- [ ] Relevant docs and full quality validation; local specialist review.
- [ ] Coordinated staging lease and runtime validation.
- [ ] PR, CI, CodeRabbit request/wait, merge and production deploy.
- [ ] Verify root storage_safety completion, no new NOMEM, normal hourly alert dedupe; append evidence and complete idea.

## Acceptance
No whole-table aggregate over grouped content. Failure of one substep does not suppress later steps or erase unrelated markers. Mutation operations cannot retry ambiguous NOMEM effects. Production symptom is verified gone before completion.

## References
Idea 01M1XKK208SJV9VJA4BXP2KBHT; task 01M4DV2PE0ARS834TY69DG3KSF. Rules 53, 62, 70. Channel reliability-wave-1008: staging lease and migration claims required. Ship disabled cleanup stopgap first if real fix exceeds a few hours.

## Validation evidence
- Root lint, typecheck (19 tasks), and build (9 tasks) pass.
- Retry unit suites: 30/30 pass. Final expanded SQLite storage-safety + incremental-materialization suites: 45/45 pass.
- Negative control: original aggregate reads 131 rows (bound <20), test fails.
- Negative control: remove sync and session transaction, marker is not committed before fault and first grouped/FTS row is lost, tests fail.
- Negative control: rethrow substep failure, subsequent eligible activity-event deletion does not occur, both fault-recording variants fail.
- An initial metadata-read liveness assertion proved non-discriminating because alarm rescheduling also read it; replaced with actual deletion and persisted row absence.
- Fault uses real SQLite transaction rollback plus synthetic NOMEM. Native allocator exhaustion is not reproduced locally. Raw OR ROLLBACK poisons local workerd bookkeeping and was rejected as a test strategy.
- No flag override in either GitHub Environment; deployed production cleanup binding=true before changes. Production baseline 13:43Z shows root NOMEM ~once/minute and hourly threshold alerts.
