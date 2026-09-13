-- Additive only: no table rebuild, no DROP, no data movement.
--
-- capacity_pools.revision is the pool-level input to the placement authority generation, but
-- reconciliation never bumped it for catalog-driven changes. A price-only refresh can reorder
-- ranking (compareCapacityCandidates ranks on price) so that a DIFFERENT candidate becomes
-- cheapest while the already-selected candidate's own attributes are untouched — its candidate
-- authority is unchanged, and a plan authorized against the old ranking stayed authoritative.
--
-- selection_digest stores a stable digest of the pool's selection-affecting candidate state.
-- Reconciliation bumps revision only when that digest changes, so an identical refresh is a
-- no-op and a selection-affecting change invalidates prior placement authority exactly once.
-- NULL means "not yet computed": the first reconcile after upgrade records the digest without
-- bumping the revision, so upgrading does not mass-invalidate healthy in-flight plans.

ALTER TABLE capacity_pools
  ADD COLUMN selection_digest TEXT;
