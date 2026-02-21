-- Migration: Add autoProvisionedNodeId to tasks for autonomous task runs
-- When a task run auto-creates a node, this tracks it for cleanup
ALTER TABLE tasks ADD COLUMN auto_provisioned_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;

-- Index for finding tasks that auto-provisioned a specific node
CREATE INDEX idx_tasks_auto_provisioned_node ON tasks(auto_provisioned_node_id) WHERE auto_provisioned_node_id IS NOT NULL;
