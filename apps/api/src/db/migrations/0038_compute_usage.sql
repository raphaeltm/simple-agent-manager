-- Compute usage metering: tracks vCPU-hours per user per workspace
CREATE TABLE compute_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  server_type TEXT NOT NULL,
  vcpu_count INTEGER NOT NULL,
  credential_source TEXT NOT NULL DEFAULT 'user',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_compute_usage_user_period ON compute_usage(user_id, started_at);
CREATE INDEX idx_compute_usage_workspace ON compute_usage(workspace_id);
