-- ProjectData terminal archive-sharding bridge.
--
-- Disabled by default in Worker config. These D1 rows are the external
-- coordinator journal and the exact-routing source of truth; ProjectData root
-- Durable Objects do not drive archive migration from alarms.

CREATE TABLE project_data_archive_circuit_breakers (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'frozen')),
  reason TEXT,
  opened_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE project_data_archive_migrations (
  migration_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'candidate',
    'leased',
    'intent_prepared',
    'target_prepared',
    'copying',
    'target_sealed',
    'recovery_manifest_persisted',
    'source_deleted',
    'published',
    'failed',
    'poisoned',
    'frozen'
  )),
  source_owner_name TEXT NOT NULL,
  target_owner_name TEXT NOT NULL,
  source_generation INTEGER NOT NULL DEFAULT 0 CHECK (source_generation = 0),
  target_generation INTEGER NOT NULL CHECK (target_generation > 0),
  source_intent_token TEXT,
  terminal_version_sha256 TEXT,
  target_aggregate_sha256 TEXT,
  r2_manifest_key TEXT,
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  error_message TEXT,
  candidate_at INTEGER,
  intent_prepared_at INTEGER,
  target_prepared_at INTEGER,
  copying_started_at INTEGER,
  target_sealed_at INTEGER,
  recovery_manifest_persisted_at INTEGER,
  source_deleted_at INTEGER,
  published_at INTEGER,
  poisoned_at INTEGER,
  frozen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, session_id, target_generation)
);

CREATE INDEX idx_project_data_archive_migrations_state_lease
  ON project_data_archive_migrations(state, lease_expires_at, updated_at);

CREATE INDEX idx_project_data_archive_migrations_project_state
  ON project_data_archive_migrations(project_id, state, updated_at);

CREATE INDEX idx_project_data_archive_migrations_session
  ON project_data_archive_migrations(project_id, session_id, state);

CREATE TABLE project_data_session_locations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  location_state TEXT NOT NULL CHECK (location_state IN (
    'root',
    'migrating',
    'archive_shard',
    'frozen'
  )),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('root', 'archive_shard')),
  owner_name TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  migration_id TEXT REFERENCES project_data_archive_migrations(migration_id) ON DELETE SET NULL,
  source_owner_name TEXT,
  target_owner_name TEXT,
  target_aggregate_sha256 TEXT,
  routing_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (routing_schema_version = 1),
  published_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id)
);

CREATE INDEX idx_project_data_session_locations_owner
  ON project_data_session_locations(owner_kind, owner_name, generation);

CREATE INDEX idx_project_data_session_locations_state
  ON project_data_session_locations(location_state, updated_at);

CREATE TABLE project_data_session_index_cursors (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  cursor_updated_at INTEGER,
  cursor_id TEXT,
  full_sync_started_at INTEGER,
  last_progress_at INTEGER,
  observed_session_count INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

ALTER TABLE session_index_coverage ADD COLUMN backfill_cursor_updated_at INTEGER;
ALTER TABLE session_index_coverage ADD COLUMN backfill_cursor_id TEXT;
ALTER TABLE session_index_coverage ADD COLUMN backfill_started_at INTEGER;
ALTER TABLE session_index_coverage ADD COLUMN backfill_completed_at INTEGER;
