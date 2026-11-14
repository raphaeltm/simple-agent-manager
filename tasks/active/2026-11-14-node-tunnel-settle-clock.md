# Deterministic node tunnel settle-window test

SAM task: 01M7C0Y7N8RYTEFJ1TVFN8TCYT. Existing idea: 01M77KN2VSET45ZYKJ5DJ5KBNY.

## Problem and research
CI 43546528170 attempt 2 failed the in-window assertion in node-tunnel-hardening.test.ts:108 (cleaned/0 instead of cleanup_pending/1). Earlier sightings: 43194907710 and 43222356555. Separate JWT defect belongs to another task.
Production node-tunnel-cleanup.ts samples Date.now at inventory start and compares it with COALESCE(pending_create_last_at, created_at) from node-tunnel-journal.ts. The test starts its clock after strandedPendingCreate setup, which may cross the persisted settle boundary sooner than the assertion assumes. Verify with forced setup delay before deciding whether production needs a change.

## Checklist and acceptance
- [ ] Prove the code-level cause with deterministic old-test failure under a forced setup delay.
- [ ] Use one controlled persisted timebase; retain exact before/at/after boundary and eventual cleanup assertions.
- [ ] Audit neighboring time-sensitive cases; preserve all production lifecycle and ownership guards.
- [ ] Run full focused file at least 30 times without errors; meaningful guard mutation must fail.
- [ ] Run quality checks, local test/Cloudflare/completion reviews, reconcile CI and best-effort CodeRabbit.
- [ ] Link PR/session to existing idea and send head/results/merge outcome to shepherd and coordinator.

## Validation and deployment
Pending. Test-only changes have no deployed behavior; runtime staging is not applicable per explicit task scope. Do not mutate shared staging. Production verification limited to health/version.

## References
apps/api/tests/unit/services/node-tunnel-hardening.test.ts; apps/api/src/services/node-tunnel-cleanup.ts; apps/api/src/services/node-tunnel-journal.ts; .claude/rules/25-review-merge-gate.md.
