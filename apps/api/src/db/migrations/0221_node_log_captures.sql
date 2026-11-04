-- Black box recorder index: bounded raw VM log captures (vm-agent, systemd, cloud-init) taken
-- before node teardown and when a node turns unhealthy. The gzipped JSON lives in R2 under
-- r2_key; every row carries expires_at and the daily purge deletes the object, then the row.
-- Additive. No FK to nodes: captures exist to outlive the node.
CREATE TABLE node_log_captures (
  id TEXT PRIMARY KEY NOT NULL,
  node_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  capture_trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  r2_key TEXT,
  sources_json TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0,
  raw_bytes INTEGER NOT NULL DEFAULT 0,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_node_log_captures_node_created ON node_log_captures(node_id, created_at);
CREATE INDEX idx_node_log_captures_expires ON node_log_captures(expires_at);
