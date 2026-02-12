-- Add first-class Nodes and Agent Sessions for multi-workspace hierarchy

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  vm_size TEXT NOT NULL DEFAULT 'medium',
  vm_location TEXT NOT NULL DEFAULT 'nbg1',
  provider_instance_id TEXT,
  ip_address TEXT,
  backend_dns_record_id TEXT,
  last_heartbeat_at TEXT,
  health_status TEXT NOT NULL DEFAULT 'unhealthy',
  heartbeat_stale_after_seconds INTEGER NOT NULL DEFAULT 180,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nodes_user_id ON nodes(user_id);

ALTER TABLE workspaces ADD COLUMN node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN display_name TEXT;
ALTER TABLE workspaces ADD COLUMN normalized_display_name TEXT;

CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_node_id ON workspaces(node_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_node_display_name_unique
ON workspaces(node_id, normalized_display_name)
WHERE node_id IS NOT NULL AND normalized_display_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  label TEXT,
  stopped_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_id ON agent_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_id ON agent_sessions(user_id);
