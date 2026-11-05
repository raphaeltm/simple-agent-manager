-- One compact row per keep/kill decision about a node (NodeLifecycle DO, cleanup sweep,
-- warm handoff), so "why is this node still alive?" has a queryable answer.
-- Additive. No FK to nodes: rows must survive deletion of the node row. Retention is
-- bounded by the daily purge (operations.nodeDecisionLogRetentionDays).
CREATE TABLE node_lifecycle_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  node_id TEXT NOT NULL,
  source TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  workspace_count INTEGER,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_node_lifecycle_decisions_node_created
  ON node_lifecycle_decisions(node_id, created_at);
CREATE INDEX idx_node_lifecycle_decisions_created
  ON node_lifecycle_decisions(created_at);
