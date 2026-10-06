-- ProjectData Durable Object storage telemetry.
--
-- One row per project records the latest direct per-object SQLite
-- `databaseSize` measurement from the ProjectData Durable Object. This is an
-- additive D1 index only; it does not mutate ProjectData object schemas.

CREATE TABLE project_data_storage_telemetry (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  measured_at INTEGER NOT NULL CHECK (measured_at > 0),
  database_size_bytes INTEGER NOT NULL CHECK (database_size_bytes >= 0),
  limit_bytes INTEGER NOT NULL CHECK (limit_bytes > 0),
  usage_ratio REAL NOT NULL CHECK (usage_ratio >= 0),
  status TEXT NOT NULL CHECK (status IN ('ok', 'notice', 'warning', 'critical', 'degraded')),
  last_alarm_at INTEGER,
  last_alert_at INTEGER,
  last_alert_status TEXT CHECK (
    last_alert_status IS NULL
    OR last_alert_status IN ('ok', 'notice', 'warning', 'critical', 'degraded')
  ),
  last_purge_at INTEGER,
  last_purge_reason TEXT,
  last_purge_rows INTEGER,
  last_purge_database_size_bytes INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)),
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer))
);

CREATE INDEX idx_project_data_storage_telemetry_status
  ON project_data_storage_telemetry(status, usage_ratio DESC, measured_at DESC);

CREATE INDEX idx_project_data_storage_telemetry_measured_at
  ON project_data_storage_telemetry(measured_at DESC);
