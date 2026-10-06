-- Runtime-neutral hibernate/restore snapshots for agent sessions.
CREATE TABLE session_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_session_id TEXT NOT NULL,
  agent_session_id TEXT,
  runtime TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  degradation TEXT NOT NULL DEFAULT 'none',
  home_r2_key TEXT,
  wip_r2_key TEXT,
  manifest_r2_key TEXT NOT NULL,
  base_commit TEXT,
  expires_at TEXT NOT NULL,
  manifest_json TEXT,
  restore_status TEXT,
  restore_message TEXT,
  restored_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_session_snapshots_chat_session_id
  ON session_snapshots(chat_session_id);

CREATE INDEX idx_session_snapshots_workspace_id
  ON session_snapshots(workspace_id);

CREATE INDEX idx_session_snapshots_expires_at
  ON session_snapshots(expires_at);
