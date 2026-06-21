-- App-deployment control-surface substrate.
-- Additive migration only: deployment_environments is a parent table with
-- cascading children, so this migration must never recreate or drop it.

ALTER TABLE deployment_environments ADD COLUMN observed_applied_seq INTEGER;
ALTER TABLE deployment_environments ADD COLUMN observed_status TEXT;
ALTER TABLE deployment_environments ADD COLUMN observed_error_message TEXT;
ALTER TABLE deployment_environments ADD COLUMN observed_services_json TEXT;
ALTER TABLE deployment_environments ADD COLUMN observed_deploy_status_json TEXT;
ALTER TABLE deployment_environments ADD COLUMN observed_disk_telemetry_json TEXT;
ALTER TABLE deployment_environments ADD COLUMN observed_at TEXT;

ALTER TABLE deployment_environments ADD COLUMN agent_deploy_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployment_environments ADD COLUMN agent_deploy_enabled_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE deployment_environments ADD COLUMN agent_deploy_enabled_at TEXT;
ALTER TABLE deployment_environments ADD COLUMN agent_deploy_disabled_at TEXT;
ALTER TABLE deployment_environments ADD COLUMN allowed_deploy_profile_ids_json TEXT;

CREATE INDEX IF NOT EXISTS idx_deployment_environments_observed_status
  ON deployment_environments(observed_status);

CREATE INDEX IF NOT EXISTS idx_deployment_environments_agent_deploy_enabled
  ON deployment_environments(agent_deploy_enabled);
