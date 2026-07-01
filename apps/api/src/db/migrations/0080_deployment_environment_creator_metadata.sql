-- Additive audit metadata for user-created and agent-created deployment environments.
-- deployment_environments has cascading children; never recreate or drop it.

ALTER TABLE deployment_environments ADD COLUMN created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE deployment_environments ADD COLUMN created_by_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL;
ALTER TABLE deployment_environments ADD COLUMN created_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE deployment_environments ADD COLUMN created_by_workspace_id TEXT;
ALTER TABLE deployment_environments ADD COLUMN creation_source TEXT NOT NULL DEFAULT 'user';

CREATE INDEX IF NOT EXISTS idx_deployment_environments_created_by_agent_profile
  ON deployment_environments(created_by_agent_profile_id);

CREATE INDEX IF NOT EXISTS idx_deployment_environments_creation_source
  ON deployment_environments(creation_source);
