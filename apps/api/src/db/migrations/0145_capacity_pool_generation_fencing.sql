-- Add durable generation fences for capacity-pool reconciliation publishers.
-- These columns let D1 predicates reject stale source and catalog publications
-- without deleting existing rows or weakening foreign-key ownership.

ALTER TABLE capacity_sources
  ADD COLUMN source_generation INTEGER NOT NULL DEFAULT 0 CHECK (source_generation >= 0);

ALTER TABLE capacity_pool_candidates
  ADD COLUMN catalog_generation INTEGER NOT NULL DEFAULT 0 CHECK (catalog_generation >= 0);

CREATE INDEX IF NOT EXISTS idx_capacity_sources_scope_generation
  ON capacity_sources(scope, owner_user_id, owner_project_id, source_generation);

CREATE INDEX IF NOT EXISTS idx_capacity_pool_candidates_source_generation
  ON capacity_pool_candidates(capacity_source_id, catalog_generation);
