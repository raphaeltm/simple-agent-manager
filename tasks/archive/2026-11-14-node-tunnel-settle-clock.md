# Deterministic node tunnel settle-window test

SAM task: 01M7C0Y7N8RYTEFJ1TVFN8TCYT. Existing idea: 01M77KN2VSET45ZYKJ5DJ5KBNY.

## Problem and research

CI 43546528170 attempt 2 failed the in-window assertion in node-tunnel-hardening.test.ts:108 (cleaned/0 instead of cleanup_pending/1). Earlier sightings: 43194907710 and 43222356555. Separate JWT defect belongs to another task.
Production node-tunnel-cleanup.ts samples Date.now at inventory start and compares it with COALESCE(pending_create_last_at, created_at) from node-tunnel-journal.ts. The test starts its clock after strandedPendingCreate setup, which may cross the persisted settle boundary sooner than the assertion assumes. Verify with forced setup delay before deciding whether production needs a change.

## Checklist and acceptance

- [x] Prove the code-level cause with deterministic old-test failure under a forced setup delay.
- [x] Use one controlled persisted timebase; retain exact before/at/after boundary and eventual cleanup assertions.
- [x] Audit neighboring time-sensitive cases; preserve all production lifecycle and ownership guards.
- [x] Run full focused file at least 30 times without errors; meaningful guard mutation must fail.
- [x] Run quality checks and local test/Cloudflare/completion reviews.
- [x] Link session and record findings/validation in existing idea and coordination channel.

## Validation and deployment

Local validation complete. Test-only changes have no deployed behavior; runtime staging is not applicable per explicit task scope. Do not mutate shared staging. Production verification limited to health/version.

## References

apps/api/tests/unit/services/node-tunnel-hardening.test.ts; apps/api/src/services/node-tunnel-cleanup.ts; apps/api/src/services/node-tunnel-journal.ts; .claude/rules/25-review-merge-gate.md.

## Cause and red/green evidence

Claim writes pending_create_last_at before provisionNode returns; journal exposes COALESCE(pending_create_last_at, created_at). Cleanup compares age at inventory START, while sweep argument controls only due-row selection. Original test started its assertion clock after setup. Forced setup delay of1000ms from controlled .999 reproduces original failure (28pass/1fail); zero-delay case passes. Persisted-anchor correction passes29/29. No evidence of a production race.
Neighbor audit: inventory-start test already reads persisted stamp; late-commit and last-error tests select due time but do not compare elapsed from a new start; migration and CAS tests explicitly age the persisted row. No neighboring copy of the late-start error found.
Negative control: temporarily replace age>=settleMs with age>=0:8failed/21passed, including both delay variants and exact-boundary test. Restored production file byte-identical.
Direct task-only push to main was rejected by required Durable Object Workers repository rule; task history retained in ordinary PR. Existing task-backed branch used; no resource/provider overrides or new dependencies/settings.

Local specialist review: test-engineer PASS, cloudflare-specialist PASS (read-only local subagent; no findings). Root lint22tasks/typecheck36tasks/build18tasks pass. Initial root tests collided with concurrent installer build-generated site-static asset removal; retry after builds completed passes all39tasks, including installer147/147 and API15126passed/4existing skipped (1009filespassed/3existing skipped). Original CI attempt2 job logs independently confirm exact line108 symptom and sole API failure (15057 passed).

Repetition results:30/30 independent full-file invocations pass29/29 each (870 executions), zero unhandled-error logs; forced0/1000ms cases included every run. Repetitions overlapped ordinary full-repo validation (loaded execution). Additional V8 coverage focused run29/29 passes (cleanup file only74.73% statements/74.07% branches; not complete tunnel-suite coverage).

Completion-validator local subagent:PASS across A-F; no implementation findings.

## Post-implementation release gates

PR association, final full-head CI/review reconciliation, best-effort CodeRabbit request/wait, merge and shepherd/coordinator completion delivery are tracked in the PR body and existing idea timeline after this implementation archive. No extra exact-SHA approval hold applies.
