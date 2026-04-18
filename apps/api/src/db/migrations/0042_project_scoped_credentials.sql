-- Add project_id to credentials so agent API keys / OAuth tokens can be scoped per-project.
-- NULL project_id = user-scoped (current behavior, unchanged for all existing rows).
-- Non-NULL project_id = project-scoped (overrides user-scoped credential when a task runs in that project).
ALTER TABLE credentials ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;

-- Replace the user/agent/kind unique index so (user, agent, kind) is still unique per scope.
-- SQLite treats each NULL project_id as distinct, but we need NULL to collapse to a single user-scoped
-- row per (user, agent, kind). Use two partial unique indexes: one for NULL and one for non-NULL.
DROP INDEX IF EXISTS idx_credentials_user_agent_kind;

CREATE UNIQUE INDEX idx_credentials_user_agent_kind_user_scope
  ON credentials (user_id, agent_type, credential_kind)
  WHERE credential_type = 'agent-api-key' AND project_id IS NULL;

CREATE UNIQUE INDEX idx_credentials_user_agent_kind_project_scope
  ON credentials (user_id, project_id, agent_type, credential_kind)
  WHERE credential_type = 'agent-api-key' AND project_id IS NOT NULL;

-- Active lookup index: include project_id so the resolution query can filter cheaply.
DROP INDEX IF EXISTS idx_credentials_active;

CREATE INDEX idx_credentials_active
  ON credentials (user_id, project_id, agent_type, is_active)
  WHERE credential_type = 'agent-api-key' AND is_active = 1;
