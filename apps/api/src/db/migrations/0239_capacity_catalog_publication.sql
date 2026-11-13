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
 payload TEXT NOT NULL
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
