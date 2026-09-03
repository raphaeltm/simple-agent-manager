-- Persist exact, bounded, read-only ProjectData relief preflight progress.
-- A plan ID is immutable for one project and one fixed eligibility cutoff.

CREATE TABLE project_data_storage_relief_preflights (
  plan_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
    'running',
    'complete',
    'truncated',
    'failed'
  )),
  cutoff_created_at INTEGER NOT NULL CHECK (cutoff_created_at >= 0),
  config_json TEXT NOT NULL,
  cursor_json TEXT,
  batches_started INTEGER NOT NULL DEFAULT 0 CHECK (batches_started >= 0),
  rows_examined INTEGER NOT NULL DEFAULT 0 CHECK (rows_examined >= 0),
  eligible_rows INTEGER NOT NULL DEFAULT 0 CHECK (eligible_rows >= 0),
  eligible_bytes INTEGER NOT NULL DEFAULT 0 CHECK (eligible_bytes >= 0),
  legacy_oversized_rows INTEGER NOT NULL DEFAULT 0 CHECK (legacy_oversized_rows >= 0),
  legacy_oversized_bytes INTEGER NOT NULL DEFAULT 0 CHECK (legacy_oversized_bytes >= 0),
  rearchivable_oversized_rows INTEGER NOT NULL DEFAULT 0 CHECK (rearchivable_oversized_rows >= 0),
  rearchivable_oversized_bytes INTEGER NOT NULL DEFAULT 0 CHECK (rearchivable_oversized_bytes >= 0),
  oversized_rows INTEGER NOT NULL DEFAULT 0 CHECK (oversized_rows >= 0),
  oversized_bytes INTEGER NOT NULL DEFAULT 0 CHECK (oversized_bytes >= 0),
  archived_rows INTEGER NOT NULL DEFAULT 0 CHECK (archived_rows >= 0),
  skipped_rows INTEGER NOT NULL DEFAULT 0 CHECK (skipped_rows >= 0),
  session_count INTEGER NOT NULL DEFAULT 0 CHECK (session_count >= 0),
  sessions_json TEXT NOT NULL DEFAULT '{}',
  sessions_sha256 TEXT,
  database_size_bytes INTEGER,
  next_eligible_at INTEGER NOT NULL DEFAULT 0 CHECK (next_eligible_at >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_project_data_storage_relief_preflights_project_status
  ON project_data_storage_relief_preflights(project_id, status, updated_at);

CREATE INDEX idx_project_data_storage_relief_preflights_next_eligible
  ON project_data_storage_relief_preflights(status, next_eligible_at);
