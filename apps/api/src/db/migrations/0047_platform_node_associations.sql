CREATE TABLE IF NOT EXISTS platform_node_associations (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK(reason IN ('trial', 'support', 'migration', 'other')),
  associated_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_platform_node_associations_user_id
  ON platform_node_associations(user_id);

CREATE INDEX IF NOT EXISTS idx_platform_node_associations_reason
  ON platform_node_associations(reason);
