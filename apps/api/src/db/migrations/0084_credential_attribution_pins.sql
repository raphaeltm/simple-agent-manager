-- Wave 5 shared-project credential attribution pins.
-- Non-secret metadata only: records which principal/scope credential resolution
-- used so descendants and teardown do not re-resolve against a different actor.

ALTER TABLE tasks ADD COLUMN credential_attribution_user_id TEXT;
ALTER TABLE tasks ADD COLUMN credential_attribution_project_id TEXT;
ALTER TABLE tasks ADD COLUMN credential_attribution_source TEXT DEFAULT 'user';

ALTER TABLE nodes ADD COLUMN credential_attribution_user_id TEXT;
ALTER TABLE nodes ADD COLUMN credential_attribution_project_id TEXT;
ALTER TABLE nodes ADD COLUMN credential_attribution_source TEXT DEFAULT 'user';

CREATE INDEX IF NOT EXISTS idx_tasks_credential_attribution_user
  ON tasks(credential_attribution_user_id);

CREATE INDEX IF NOT EXISTS idx_nodes_credential_attribution_user
  ON nodes(credential_attribution_user_id);
