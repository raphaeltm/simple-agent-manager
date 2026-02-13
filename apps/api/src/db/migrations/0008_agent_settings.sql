-- Add per-user, per-agent settings for model selection and permission mode.
-- Extensible for future tool allow/deny rules and MCP server configuration.

CREATE TABLE IF NOT EXISTS agent_settings (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  model TEXT,
  permission_mode TEXT,
  allowed_tools TEXT,
  denied_tools TEXT,
  additional_env TEXT,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)),
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, agent_type)
);

CREATE INDEX IF NOT EXISTS idx_agent_settings_user_id ON agent_settings(user_id);
