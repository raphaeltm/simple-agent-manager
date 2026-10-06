-- Deployment environment secrets (slice 2)
-- Environment-scoped secrets encrypted at rest (AES-256-GCM).
-- Write-only from API: set, overwrite, delete, list names — never read back values.
-- Additive migration only (rule 31).

CREATE TABLE deployment_secrets (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES deployment_environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_deployment_secrets_env_name
  ON deployment_secrets(environment_id, name);

CREATE INDEX idx_deployment_secrets_environment_id
  ON deployment_secrets(environment_id);

-- Track when secrets were last modified for stale-config detection.
ALTER TABLE deployment_environments ADD COLUMN secrets_updated_at TEXT;
