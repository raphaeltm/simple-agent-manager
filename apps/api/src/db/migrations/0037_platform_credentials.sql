-- Platform-wide credential management for admin-set fallback keys
-- Used when users don't have their own cloud provider or agent API keys

CREATE TABLE platform_credentials (
  id TEXT PRIMARY KEY,
  credential_type TEXT NOT NULL,          -- 'cloud-provider' or 'agent-api-key'
  provider TEXT,                           -- 'hetzner', 'scaleway', 'gcp' (for cloud-provider type)
  agent_type TEXT,                         -- 'claude-code', 'openai-codex' (for agent-api-key type)
  credential_kind TEXT NOT NULL DEFAULT 'api-key',  -- 'api-key', 'oauth-token'
  label TEXT NOT NULL,                     -- admin-facing label
  encrypted_token TEXT NOT NULL,
  iv TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_platform_credentials_type_provider
  ON platform_credentials(credential_type, provider)
  WHERE credential_type = 'cloud-provider';

CREATE INDEX idx_platform_credentials_type_agent
  ON platform_credentials(credential_type, agent_type)
  WHERE credential_type = 'agent-api-key';

-- Track whether a node was provisioned with user or platform credentials
ALTER TABLE nodes ADD COLUMN credential_source TEXT DEFAULT 'user';

-- Track whether a task used user or platform agent credentials
ALTER TABLE tasks ADD COLUMN agent_credential_source TEXT DEFAULT 'user';
