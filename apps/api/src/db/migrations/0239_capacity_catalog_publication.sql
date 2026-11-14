-- Publication progress must never mutate the last trustworthy catalog in place.
ALTER TABLE capacity_pools ADD COLUMN catalog_published_at TEXT;
UPDATE capacity_pools SET catalog_published_at = COALESCE(last_reconciled_at, updated_at)
 WHERE migration_state = 'complete' AND configuration_state <> 'migration-pending';
CREATE TABLE capacity_pool_candidate_staging (
 id TEXT PRIMARY KEY NOT NULL,
 pool_id TEXT NOT NULL REFERENCES capacity_pools(id) ON DELETE CASCADE,
 capacity_source_id TEXT NOT NULL REFERENCES capacity_sources(id) ON DELETE CASCADE,
 digest TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 generation INTEGER NOT NULL,
 primary_id TEXT NOT NULL,
 provider TEXT,
 location TEXT,
 workload_role TEXT NOT NULL DEFAULT 'workspace',
 runtime TEXT,
 machine_class TEXT,
 machine_size TEXT,
 provider_instance_type TEXT,
 provider_instance_sku TEXT,
 provider_instance_display_name TEXT,
 provider_instance_vcpu_count INTEGER,
 provider_instance_memory_mb INTEGER,
 provider_instance_disk_gb INTEGER,
 provider_instance_boot_disk_size_gb INTEGER,
 provider_instance_image TEXT,
 provider_instance_architecture TEXT,
 provider_instance_price_display TEXT,
 provider_instance_price_currency TEXT,
 provider_instance_price_monthly_cents INTEGER,
 provider_instance_price_hourly_micros INTEGER,
 provider_instance_catalog_source TEXT,
 provider_instance_catalog_last_seen_at TEXT,
 catalog_availability TEXT NOT NULL DEFAULT 'available',
 catalog_unavailable_at TEXT,
 catalog_returned_at TEXT,
 catalog_generation INTEGER NOT NULL DEFAULT 0,
 authority_generation INTEGER NOT NULL DEFAULT 0,
 priority INTEGER NOT NULL DEFAULT 0,
 candidate_order INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'active',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_capacity_candidate_staging_publication
 ON capacity_pool_candidate_staging(pool_id, capacity_source_id, digest, ordinal);
-- Scope work can be queued before a newly connected scope has materialized its default pool.
CREATE TABLE capacity_pool_refreshes (
 pool_id TEXT PRIMARY KEY NOT NULL,
 scope TEXT NOT NULL,
 owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 owner_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
 state TEXT NOT NULL DEFAULT 'pending',
 generation INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 started_at INTEGER NOT NULL,
 deadline_at INTEGER NOT NULL,
 next_attempt_at INTEGER NOT NULL,
 last_success_at INTEGER,
 last_error TEXT
);
CREATE INDEX idx_capacity_pool_refreshes_due ON capacity_pool_refreshes(state, next_attempt_at);

CREATE INDEX idx_capacity_pools_migration_state ON capacity_pools(migration_state, is_default);
