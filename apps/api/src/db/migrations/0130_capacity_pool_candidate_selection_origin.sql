-- Track whether a capacity-pool candidate status came from default reconciliation
-- or an explicit user/admin edit. This lets reconciliation heal old system-seeded
-- broad active selections without disabling later explicit user additions.
ALTER TABLE capacity_pool_candidates
  ADD COLUMN selection_origin TEXT NOT NULL DEFAULT 'system'
  CHECK (selection_origin IN ('system', 'user'));
