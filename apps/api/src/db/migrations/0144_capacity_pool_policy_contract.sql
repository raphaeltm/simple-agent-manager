-- Additive policy-contract fields for default capacity pools.
-- These columns separate configured pool state from inherited default scope
-- resolution, and preserve last-known catalog availability without deleting
-- explicit candidate membership.

ALTER TABLE capacity_pools ADD COLUMN configuration_state TEXT NOT NULL DEFAULT 'configured-ready' CHECK (configuration_state IN ('configured-ready', 'configured-empty', 'source-disabled', 'catalog-unavailable', 'migration-pending'));
ALTER TABLE capacity_pools ADD COLUMN last_reconciled_at TEXT;
ALTER TABLE capacity_pools ADD COLUMN migration_version TEXT;
ALTER TABLE capacity_pools ADD COLUMN migration_state TEXT NOT NULL DEFAULT 'complete';

CREATE INDEX IF NOT EXISTS idx_capacity_pools_configuration_state ON capacity_pools(configuration_state);

ALTER TABLE capacity_pool_candidates ADD COLUMN catalog_availability TEXT NOT NULL DEFAULT 'available' CHECK (catalog_availability IN ('available', 'last-known-unavailable'));
ALTER TABLE capacity_pool_candidates ADD COLUMN catalog_unavailable_at TEXT;
ALTER TABLE capacity_pool_candidates ADD COLUMN catalog_returned_at TEXT;

CREATE INDEX IF NOT EXISTS idx_capacity_pool_candidates_catalog_availability ON capacity_pool_candidates(catalog_availability);
