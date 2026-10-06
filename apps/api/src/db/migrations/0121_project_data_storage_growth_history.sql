-- ProjectData storage growth history and cleanup health.
--
-- Additive D1-only migration. It preserves the latest-row telemetry table that
-- existing readers use, and adds append-only history so bytes/day growth and
-- time-to-limit can be computed after each ProjectData DO measurement.

ALTER TABLE project_data_storage_telemetry
  ADD COLUMN growth_rate_bytes_per_day REAL;

ALTER TABLE project_data_storage_telemetry
  ADD COLUMN estimated_days_to_limit REAL;

ALTER TABLE project_data_storage_telemetry
  ADD COLUMN cleanup_health TEXT CHECK (
    cleanup_health IS NULL
    OR cleanup_health IN ('not_needed', 'running', 'target_reached', 'target_unreachable', 'failed')
  );

ALTER TABLE project_data_storage_telemetry
  ADD COLUMN reclaimable_bytes INTEGER;

ALTER TABLE project_data_storage_telemetry
  ADD COLUMN category_breakdown_json TEXT;

ALTER TABLE project_data_storage_telemetry
  ADD COLUMN last_alert_reason TEXT;

CREATE TABLE project_data_storage_telemetry_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  measured_at INTEGER NOT NULL CHECK (measured_at > 0),
  database_size_bytes INTEGER NOT NULL CHECK (database_size_bytes >= 0),
  limit_bytes INTEGER NOT NULL CHECK (limit_bytes > 0),
  usage_ratio REAL NOT NULL CHECK (usage_ratio >= 0),
  status TEXT NOT NULL CHECK (status IN ('ok', 'notice', 'warning', 'critical', 'degraded')),
  growth_rate_bytes_per_day REAL,
  estimated_days_to_limit REAL,
  cleanup_health TEXT CHECK (
    cleanup_health IS NULL
    OR cleanup_health IN ('not_needed', 'running', 'target_reached', 'target_unreachable', 'failed')
  ),
  reclaimable_bytes INTEGER,
  category_breakdown_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer))
);

CREATE INDEX idx_project_data_storage_telemetry_history_project_measured
  ON project_data_storage_telemetry_history(project_id, measured_at DESC);

CREATE INDEX idx_project_data_storage_telemetry_history_status_measured
  ON project_data_storage_telemetry_history(status, measured_at DESC);

CREATE INDEX idx_project_data_storage_telemetry_history_cleanup_health_measured
  ON project_data_storage_telemetry_history(cleanup_health, measured_at DESC);
