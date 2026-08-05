CREATE TABLE diagnostic_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  platform_error_id TEXT NOT NULL UNIQUE,
  node_id TEXT NOT NULL,
  workspace_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'available', 'failed', 'expired')),
  artifact_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  manifest_json TEXT,
  preview_json TEXT,
  failure_reason TEXT,
  expires_at TEXT NOT NULL,
  delete_after TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_diagnostic_incidents_node_status
  ON diagnostic_incidents(node_id, status, created_at);
CREATE INDEX idx_diagnostic_incidents_expiry
  ON diagnostic_incidents(status, expires_at);
CREATE INDEX idx_diagnostic_incidents_delete_after
  ON diagnostic_incidents(delete_after);

CREATE TABLE diagnostic_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  incident_id TEXT NOT NULL REFERENCES diagnostic_incidents(id),
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'available', 'failed', 'expired')),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  checksum_sha256 TEXT,
  expected_bytes INTEGER NOT NULL DEFAULT 0,
  actual_bytes INTEGER,
  manifest_json TEXT,
  preview_json TEXT,
  upload_attempts INTEGER NOT NULL DEFAULT 0,
  upload_lease_id TEXT,
  upload_lease_expires_at TEXT,
  failure_reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_diagnostic_artifacts_incident_kind
  ON diagnostic_artifacts(incident_id, kind);
CREATE INDEX idx_diagnostic_artifacts_incident_status
  ON diagnostic_artifacts(incident_id, status);
CREATE INDEX idx_diagnostic_artifacts_node_status
  ON diagnostic_artifacts(node_id, status, created_at);
CREATE INDEX idx_diagnostic_artifacts_expiry
  ON diagnostic_artifacts(status, expires_at);

CREATE TABLE diagnostic_reconciliation_state (
  job_key TEXT PRIMARY KEY NOT NULL,
  cursor_created_at INTEGER,
  cursor_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
