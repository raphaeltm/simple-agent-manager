-- Project deployment credentials (GCP OIDC for Defang deployments)
-- Stores WIF configuration identifiers (not secrets) per project
CREATE TABLE IF NOT EXISTS project_deployment_credentials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'gcp',
  gcp_project_id TEXT NOT NULL,
  gcp_project_number TEXT NOT NULL,
  service_account_email TEXT NOT NULL,
  wif_pool_id TEXT NOT NULL,
  wif_provider_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_deployment_creds_project
  ON project_deployment_credentials(project_id, provider);

CREATE INDEX IF NOT EXISTS idx_project_deployment_creds_user
  ON project_deployment_credentials(user_id);
