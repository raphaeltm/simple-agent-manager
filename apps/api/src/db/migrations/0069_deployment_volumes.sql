-- Deployment volumes: environment-scoped provider block storage.
-- Each volume belongs to a deployment environment and tracks
-- the corresponding provider-side volume ID, location, and attachment state.
-- Additive migration only — no DROP TABLE (rule 31).

CREATE TABLE IF NOT EXISTS deployment_volumes (
  id              TEXT PRIMARY KEY,
  environment_id  TEXT NOT NULL REFERENCES deployment_environments(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  provider_volume_id TEXT NOT NULL,
  provider_name   TEXT NOT NULL,
  size_gb         INTEGER NOT NULL,
  location        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'available',
  attached_server_id TEXT,
  linux_device    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_volumes_env_name
  ON deployment_volumes(environment_id, name);

CREATE INDEX IF NOT EXISTS idx_deployment_volumes_environment_id
  ON deployment_volumes(environment_id);
