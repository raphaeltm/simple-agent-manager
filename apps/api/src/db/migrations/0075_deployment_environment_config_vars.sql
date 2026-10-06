-- Per-deployment-environment Compose interpolation config.
-- Secrets are encrypted in deployment_environment_config_vars and supplied
-- transiently to deployment-node Docker Compose processes, not materialized
-- into release manifests or node compose files.

ALTER TABLE deployment_environments ADD COLUMN config_updated_at TEXT;

CREATE TABLE deployment_environment_config_vars (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES deployment_environments(id) ON DELETE CASCADE,
  env_key TEXT NOT NULL,
  stored_value TEXT NOT NULL,
  value_iv TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_deployment_environment_config_vars_env_key
  ON deployment_environment_config_vars(environment_id, env_key);

CREATE INDEX idx_deployment_environment_config_vars_environment_id
  ON deployment_environment_config_vars(environment_id);
