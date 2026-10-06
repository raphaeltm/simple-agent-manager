-- Persisted cadence gate for the unscoped ProjectData archive-sharding sweep.
--
-- The Worker scheduled handler may wake every five minutes, but this singleton
-- row prevents global crash-gap recovery, candidate selection, and migration
-- from running more frequently than the configured sweep interval.

CREATE TABLE project_data_archive_global_sweep_cadence (
  sweep_name TEXT PRIMARY KEY CHECK (sweep_name = 'archive_sharding_global_sweep'),
  last_started_at INTEGER,
  last_completed_at INTEGER,
  next_eligible_at INTEGER NOT NULL DEFAULT 0 CHECK (next_eligible_at >= 0),
  last_status TEXT NOT NULL DEFAULT 'never' CHECK (last_status IN (
    'never',
    'running',
    'succeeded',
    'failed',
    'partial'
  )),
  last_skip_reason TEXT,
  last_error TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_project_data_archive_global_sweep_cadence_next_eligible
  ON project_data_archive_global_sweep_cadence(next_eligible_at);
