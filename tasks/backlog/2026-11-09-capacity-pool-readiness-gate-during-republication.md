# A pool mid-republication should keep placing on its last published catalog

## Implementation tracking (2026-11-12)

The committed-catalog readiness and durable continuation work is implemented in draft
[PR #2693](https://github.com/raphaeltm/simple-agent-manager/pull/2693), tracked by
[the active recovery task](../active/2026-11-12-resilient-catalog-wake-recovery.md).
It includes private atomic replacement, retained published capacity, bounded resumable work and
automatic accepted-wake recovery. Real staging and the coordinator's exact-SHA release gate remain
open; this backlog item is not archived or claimed shipped. The separate editor/digest optimization
below remains tracked here.

## Problem

`defaultPoolEffectiveState()` (`apps/api/src/services/default-capacity-pool-summaries.ts`) returns
`migration-pending` whenever `capacity_pools.migration_state != 'complete'`, and
`buildCapacityPoolSelection()` (`apps/api/src/services/placement-resolver-capacity.ts`) returns zero
candidates for any pool that is not `configured-ready`. Any one source whose catalog changed takes the
whole pool offline, including sources whose catalogs are fully published and unchanged.

This is the `.claude/rules/74` proxy class. The condition is "this pool has no trustworthy candidates";
the signal is "the newest catalog for some source is not fully written yet". They diverge whenever an
already-published pool is republishing: every unrepublished row is still its last-known-good value,
which is exactly what placement uses between refreshes anyway.

## Context

Found during the 2026-11-09 production stall
(`tasks/archive/2026-11-09-capacity-pool-publication-deadline-loop.md`). That fix makes a changed
catalog publish to completion in one refresh (deadline-bounded loop), so the gate is now only visible
when a catalog exceeds `operations.capacityPoolPublishBudgetMs` in one pass. Deferred because changing
placement readiness semantics needs its own review: the comment at the cursor completion logic says
"Changed semantic content resets that proof" deliberately.

## Acceptance Criteria

- [ ] A pool that was `complete` before a refresh stays placeable while a source republishes a
      changed catalog across passes; a pool that has never completed publication stays pending.
- [ ] Missing-offering cleanup still waits for complete publication.
- [ ] Divergence test (republishing pool still places) and convergence control (never-published
      pool does not) through the real resolver, proven discriminating.

## Also: cron per-invocation query budget

The scheduled reconcile (`backfillDefaultCapacityPoolsForExistingCredentials`) ensures up to 25
users and 25 projects in one invocation. Since the 2026-11-09 fix, each source with a CHANGED
catalog writes up to `operations.capacityPoolPublishBudgetMs` of batches (1 D1 query per batch plus
1 cursor write). A catalog change that hits many users at once (for example a GCP price-table
refresh) could approach the Workers per-invocation query limit. Steady state (unchanged catalogs) is
unaffected.

- [ ] Give the scheduled pass a per-invocation write budget (queries or wall time) and stop
      draining further incomplete sources once it is spent; the cursor resumes them next run.
- [ ] Test with many users whose catalogs changed, counting D1 queries per invocation.

## Also: findings from the independent review of the 2026-11-09 fix (deferred, MEDIUM)

- [ ] **Shared pass budget across scopes.** `backfillDefaultCapacityPoolsForExistingCredentials`
      (`default-capacity-pools-read.ts`) ensures up to 25 users + 25 projects sequentially, each
      with up to `operations.capacityPoolPublishBudgetMs` per source. If every scope's catalog
      changed at once at the outer limit, the pass could approach the 15-minute Cron Trigger wall
      limit and cut short later sweeps in that tick (`scheduled/handler.ts`). Stop draining scopes
      when a pass-level budget is spent; the cursor resumes them.
- [ ] **Credential mutation latency.** `reconcileCapacityPoolsForCredentialMutation` is awaited
      inline by credential routes and loops project scopes; with a changed catalog each scope now
      publishes to completion. Consider `waitUntil` (the failure path already writes retry
      markers) or the shared budget above.
- [ ] **Resume sooner after a budget overrun.** When a pass ends with publication incomplete, the
      pool stays `migration-pending` until the next refresh (daily gate in
      `claimScheduledReconciliationRun`). Let the scheduled reconcile bypass its 24 h gate while
      any default pool is `migration_state='pending'`, or fix the readiness gate above.

## Also: a person's edit republishes the whole catalog on the next refresh

Found while building `tasks/active/2026-11-09-compute-pool-editor-redesign.md`. The candidate
publication digest (`candidateSetDigest()` in
`apps/api/src/services/default-capacity-pool-candidates-publication.ts`) includes each row's
`status` and `authorityGeneration` (whose hash also includes status). A pool edit changes statuses,
so the next refresh treats the catalog as changed, rewrites every row and holds the pool at
`migration-pending` until done. With the new editor people save more often, so a 3,400-row Google
Cloud catalog is rewritten after each save.

- [ ] Decide whether status belongs in the publication digest. The upsert already preserves an
      existing row's status, so republishing cannot change it; but the candidate authority hash
      includes status and is only recomputed by a publish, so removing status from the digest
      needs the authority recompute moved to the edit path (or proven unnecessary).
- [ ] Test: a pool edit followed by an identical refresh writes no candidate rows and keeps the
      pool ready (through the real edit and ensure paths).
