-- ProjectData terminal archive-sharding bridge.
--
-- D1 is the cross-owner authority. All migration work is disabled by default
-- in Worker configuration; this additive schema alone cannot move any data.

CREATE TABLE project_data_session_locations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('root', 'migrating', 'archive_shard', 'direct_session')),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('root', 'archive_shard', 'direct_session')),
  owner_name TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  migration_id TEXT,
  routing_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id),
  UNIQUE (migration_id)
);

CREATE INDEX idx_project_data_session_locations_owner
  ON project_data_session_locations(project_id, owner_kind, owner_name, generation, session_id);

CREATE TABLE project_data_archive_migrations (
  migration_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned', 'copying', 'sealed', 'source_deleted', 'archived', 'frozen', 'failed')),
  source_owner_name TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  target_owner_name TEXT NOT NULL,
  target_generation INTEGER NOT NULL CHECK (target_generation >= 0),
  lease_token TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  terminal_version TEXT NOT NULL,
  aggregate_hash TEXT,
  manifest_r2_key TEXT,
  next_table_name TEXT,
  next_chunk_index INTEGER NOT NULL DEFAULT 0,
  next_row_key TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  source_deleted_at INTEGER,
  archived_at INTEGER,
  target_authoritative_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, session_id)
);

CREATE INDEX idx_project_data_archive_migrations_sweep
  ON project_data_archive_migrations(state, next_attempt_at, lease_expires_at, updated_at, migration_id);

CREATE TABLE project_data_archive_circuit_breakers (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_until INTEGER,
  last_failure TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE project_data_archive_candidate_deferrals (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  poisoned INTEGER NOT NULL DEFAULT 0 CHECK (poisoned IN (0, 1)),
  next_check_at INTEGER,
  check_count INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id)
);

CREATE INDEX idx_project_data_archive_candidate_deferrals_due
  ON project_data_archive_candidate_deferrals(poisoned, next_check_at, updated_at);

CREATE TABLE session_index_backfill_cursors (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  cursor_mode TEXT NOT NULL CHECK (cursor_mode IN ('full', 'delta')),
  cursor_updated_at INTEGER,
  cursor_session_id TEXT,
  high_watermark INTEGER,
  snapshot_session_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Publishing is one D1 transaction: callers first CAS the journal state from
-- source_deleted to archived, then this trigger publishes the exact target.
CREATE TRIGGER project_data_archive_publish_location
AFTER UPDATE OF state ON project_data_archive_migrations
WHEN OLD.state = 'source_deleted' AND NEW.state = 'archived'
BEGIN
  INSERT INTO project_data_session_locations (
    project_id, session_id, state, owner_kind, owner_name, generation,
    migration_id, routing_version, updated_at
  ) VALUES (
    NEW.project_id,
    NEW.session_id,
    CASE WHEN NEW.target_owner_name = NEW.project_id AND NEW.target_generation = 0
      THEN 'root' ELSE 'archive_shard' END,
    CASE WHEN NEW.target_owner_name = NEW.project_id AND NEW.target_generation = 0
      THEN 'root' ELSE 'archive_shard' END,
    NEW.target_owner_name,
    NEW.target_generation,
    CASE WHEN NEW.target_owner_name = NEW.project_id AND NEW.target_generation = 0
      THEN NULL ELSE NEW.migration_id END,
    1,
    NEW.updated_at
  )
  ON CONFLICT(project_id, session_id) DO UPDATE SET
    state = excluded.state,
    owner_kind = excluded.owner_kind,
    owner_name = excluded.owner_name,
    generation = excluded.generation,
    migration_id = excluded.migration_id,
    routing_version = excluded.routing_version,
    updated_at = excluded.updated_at;
END;

-- Publication is a true compare-and-swap over both the journal and the
-- transitional location. A stale journal must never overwrite a repaired or
-- newer routing pointer.
CREATE TRIGGER project_data_archive_publish_location_validate
BEFORE UPDATE OF state ON project_data_archive_migrations
WHEN OLD.state = 'source_deleted' AND NEW.state = 'archived'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM project_data_session_locations
     WHERE project_id = OLD.project_id AND session_id = OLD.session_id
       AND state = 'migrating'
       AND owner_name = OLD.source_owner_name
       AND generation = OLD.source_generation
       AND migration_id = OLD.migration_id
       AND routing_version = 1
       AND (
         (OLD.source_generation = 0 AND owner_kind = 'root' AND owner_name = OLD.project_id)
         OR
         (OLD.source_generation > 0 AND owner_kind = 'archive_shard')
       )
  ) THEN RAISE(ABORT, 'ProjectData archive publish location CAS mismatch') END;
END;

-- Re-home starts by CASing the existing archived journal row back to copying.
-- Abort unless the authoritative location still names the old source generation,
-- then fence exact routing in the same D1 transaction.
CREATE TRIGGER project_data_archive_rehome_validate
BEFORE UPDATE OF state ON project_data_archive_migrations
WHEN OLD.state = 'archived' AND NEW.state = 'copying'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM project_data_session_locations
     WHERE project_id = OLD.project_id AND session_id = OLD.session_id
       AND state = 'archive_shard' AND owner_kind = 'archive_shard'
       AND owner_name = OLD.target_owner_name AND generation = OLD.target_generation
       AND migration_id = OLD.migration_id
       AND routing_version = 1
  ) THEN RAISE(ABORT, 'ProjectData rehome source location mismatch') END;
  SELECT CASE WHEN NOT (
    (NEW.target_owner_name = NEW.project_id AND NEW.target_generation = 0)
    OR
    (NEW.target_owner_name != OLD.target_owner_name
      AND NEW.target_generation = OLD.target_generation + 1)
  ) THEN RAISE(ABORT, 'ProjectData rehome target generation mismatch') END;
END;

CREATE TRIGGER project_data_archive_rehome_fence_location
AFTER UPDATE OF state ON project_data_archive_migrations
WHEN OLD.state = 'archived' AND NEW.state = 'copying'
BEGIN
  UPDATE project_data_session_locations
     SET state = 'migrating', owner_kind = 'archive_shard',
         owner_name = OLD.target_owner_name, generation = OLD.target_generation,
         migration_id = NEW.migration_id, routing_version = 1, updated_at = NEW.updated_at
   WHERE project_id = OLD.project_id AND session_id = OLD.session_id;
END;
