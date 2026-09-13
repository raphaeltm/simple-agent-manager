-- Support bounded terminal-node lifecycle repair by scanning only active-looking
-- workspace rows in updated_at order before joining to terminal nodes.
CREATE INDEX IF NOT EXISTS idx_workspaces_status_updated_node
ON workspaces(status, updated_at, node_id);
