# A pool mid-republication should keep placing on its last published catalog

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
