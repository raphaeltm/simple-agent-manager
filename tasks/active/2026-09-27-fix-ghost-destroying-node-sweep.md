# Fix ghost destroying-node cleanup sweep

## Problem

PR #2157 deployed at about 04:30Z on 2026-09-27, but five production managed VM
rows remain in `status='destroying'`. The normal cleanup sweep retries them and
backs them off without reaching a terminal state.

## Production Evidence

- Read-only production D1 at investigation time returned exactly five
  `destroying` rows: `01M3BB7WG1GK21RGVBY0EDGYWB`,
  `01M3BB8MQECY1A4T67J49V164J`, `01M3BB9DN5EV2HNWGEVATE95V4`,
  `01M3C74N1JC4QDPCF2G352ZG45`, and `01M3CHFK0JZGCEJJ9XD8TW350N`.
- All five are managed workspace VMs with exact placement snapshots,
  `provider_instance_id IS NULL`, `runtime_termination_confirmed_at IS NULL`, no
  workspaces, and one linked failed auto-provisioning task.
- Production observability contains 49 post-deploy cleanup errors for those rows
  (10, 10, 10, 10, and 9 respectively).
- Every error is emitted by `sweepMaxLifetimeNodes` with
  `Failed to destroy max-lifetime node: ... instance identity is missing`.
  The stack pins the throw to `deleteStrictProviderInstance` in
  `apps/api/src/services/strict-node-deletion.ts`, reached from the call at
  `apps/api/src/scheduled/node-cleanup/node-phases.ts:212` and configured by the
  failure prefix around line 220.
- The max-lifetime phase runs before the destroying-handoff phase and writes the
  one-hour cleanup backoff after this failure. The later phase therefore cannot
  claim the row on the same tick.

## Research Findings

- The max-lifetime selector admits every status except `stopped` and `deleted`,
  including rows already owned by the `destroying` handoff state machine.
- PR #2157 safely records provider-rejection absence proof for new rejected
  creates, but the five older production rows predate that write and have no
  proof to consume.
- Missing provider identity alone cannot authorize terminal cleanup. A stale
  providerless row must be reconciled through the exact placement credential and
  the provider labels for node id, runtime incarnation, environment, and
  installation. Missing, duplicate, foreign, malformed, or unverifiable
  inventory must remain retryable and must never reach provider deletion.
- Scheduled phases and individual candidates already have containment patterns;
  the regression must prove one bad providerless row cannot block a valid one.

## Checklist

- [ ] Route `destroying` rows away from max-lifetime cleanup and into their
      dedicated handoff phase.
- [ ] Reconcile a stale providerless managed VM using its exact credential and
      full provider ownership labels before terminalization.
- [ ] Preserve exact-incarnation CAS fences and revalidate any discovered VM
      immediately before the provider delete boundary.
- [ ] Fail closed for unavailable scope, failed/partial inventory, ambiguous or
      foreign labels, duplicate matches, changed identity, and credential drift.
- [ ] Add a regression test that invokes `runNodeCleanupSweep` with production-
      shaped providerless `destroying` rows and verifies candidate isolation.
- [ ] Revert the production fix once and record that the regression test fails.
- [ ] Run focused and repository quality gates, specialist reviews, staging
      verification, PR CI, CodeRabbit, merge, and production deployment.
- [ ] After one or two production cron ticks, query D1 and report the
      `destroying` count before and after.

## Acceptance Criteria

- The real cleanup sweep terminalizes a stale, providerless `destroying` row only
  after exact scoped provider reconciliation proves the runtime absent or safely
  deletes the exact owned runtime.
- The five production rows leave `destroying` through the normal sweep; no
  production D1 row is edited by hand.
- User-owned, deployment, foreign-installation, foreign-environment, malformed,
  duplicate, and ambiguous resources are preserved.
- A failing node does not stop later candidates or later scheduled phases.
- The regression test demonstrably fails when the fix is reverted.

## References

- PR #2157 / merge `8880c8761`
- `apps/api/.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `packages/providers/.claude/rules/56-destructive-provider-ownership-proof.md`
- `tasks/active/2026-09-26-terminal-node-cleanup-missing-provider-vm.md`
