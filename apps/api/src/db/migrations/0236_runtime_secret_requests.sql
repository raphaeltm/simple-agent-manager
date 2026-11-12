-- Agent-requested runtime secrets (services/runtime-secret-requests.ts).
--
-- An agent calls the request_secret MCP tool; a human with secret:write on the project types
-- the value into a card in the conversation, and the API stores it encrypted as a project
-- runtime secret. The plaintext never passes through the agent, the chat or this table.
--
-- runtime_secret_requests: one row per request. Holds metadata only (name, reason, requested
-- TTL, who asked, who answered, outcome). Pending rows expire at expires_at (epoch ms); a cron
-- sweep marks them expired and tells the agent. Resolved rows are deleted after the admin
-- retention window by the daily purge.
--
-- project_runtime_env_vars.expires_at: epoch ms after which the value must not be used. NULL
-- means no expiry, which is what every existing row keeps (unchanged behaviour). Readers
-- exclude a row once expires_at <= now; the daily purge deletes the material afterwards.
-- project_runtime_env_vars.secret_request_id: the request that supplied the current value, so
-- the UI and agent listings can show where it came from. NULL for manually set values (every
-- existing row). A manual edit clears both columns again. ON DELETE SET NULL so purging old
-- request history never deletes a secret.
--
-- Additive only: one new table and two nullable columns. project_runtime_env_vars has no FK
-- children. Numbered 0236 because 0235 is taken by the open signed-webhooks branch (#2664).
CREATE TABLE runtime_secret_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  ttl_seconds INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fulfilled', 'declined', 'expired')),
  requester_user_id TEXT NOT NULL,
  requesting_task_id TEXT NOT NULL,
  requesting_authority_task_id TEXT NOT NULL,
  requesting_chat_session_id TEXT NOT NULL,
  requesting_agent_session_id TEXT,
  requesting_workspace_id TEXT,
  expires_at INTEGER NOT NULL,
  resolved_by TEXT,
  resolved_at INTEGER,
  secret_expires_at INTEGER,
  replaced_existing INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_runtime_secret_requests_status_expires
  ON runtime_secret_requests (status, expires_at);
CREATE INDEX idx_runtime_secret_requests_session
  ON runtime_secret_requests (requesting_chat_session_id, status);
CREATE INDEX idx_runtime_secret_requests_project_key
  ON runtime_secret_requests (project_id, env_key);
CREATE INDEX idx_runtime_secret_requests_resolved
  ON runtime_secret_requests (resolved_at);

ALTER TABLE project_runtime_env_vars ADD COLUMN expires_at INTEGER;
ALTER TABLE project_runtime_env_vars ADD COLUMN secret_request_id TEXT
  REFERENCES runtime_secret_requests(id) ON DELETE SET NULL;

CREATE INDEX idx_project_runtime_env_expires
  ON project_runtime_env_vars (expires_at) WHERE expires_at IS NOT NULL;
