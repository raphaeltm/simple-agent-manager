-- Atomic fixed-window counters for registry credential minting.
--
-- KV read-modify-write can overrun under concurrent requests. This table lets
-- the API consume a project/window quota with one SQLite upsert guarded by the
-- current request_count.
CREATE TABLE IF NOT EXISTS registry_credential_rate_limits (
  rate_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_registry_credential_rate_limits_expires_at
  ON registry_credential_rate_limits(expires_at);

CREATE INDEX IF NOT EXISTS idx_registry_credential_rate_limits_project
  ON registry_credential_rate_limits(project_id);
